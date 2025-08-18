import hre from "hardhat";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

function getDeploymentFile(network: string): string {
  const dir = join("deployments", network);
  const filePath = join(dir, `${network}.json`);
  try {
    // Check if the network-specific file exists
    require("fs").accessSync(filePath);
    return filePath;
  } catch (error) {
    throw new Error(`No deployment file found at ${filePath}`);
  }
}

async function main() {
  const { ethers, network } = hre as any;
  const [owner, nonOwner, user2] = await ethers.getSigners();

  const file = process.env.DEPLOY_JSON || getDeploymentFile(network.name || "localhost");
  const data = JSON.parse(readFileSync(file, "utf8"));
  console.log("Using deployment:", file);

  const assetAddr: string = data.params.ASSET_TOKEN;
  const coreAddr: string = data.contracts.ProtocolCore;
  const stake = data.contracts.vaults.staking;
  const lend = data.contracts.vaults.lending;

  const asset = await ethers.getContractAt("ERC20", assetAddr);

  async function getFarmStack(stack: any) {
    const farm = await ethers.getContractAt("BaseFarm", stack.BaseFarm);
    const router = await ethers.getContractAt("StrategyRouter", stack.StrategyRouter);
    const payout = await ethers.getContractAt("PayoutPolicy", stack.PayoutPolicy);
    const lockup = await ethers.getContractAt("LockupPolicy", stack.LockupPolicy);
    const reg = await ethers.getContractAt("StakeholderRegistry", stack.StakeholderRegistry);
    return { farm, router, payout, lockup, reg };
  }

  // --- 3b) Streaming accrual and claim tests (Staking) ---
  console.log(`\n[Staking] Streaming accrual and claim tests`);
  {
    const { farm, payout, reg } = await getFarmStack(stake);
    const registryAddr = await reg.getAddress();
    const ownerRecipient: string = await reg.ownerRecipient();
    console.log("StakeholderRegistry:", registryAddr, "ownerRecipient:", ownerRecipient);
    const [farmOwner, protocolOwner] = await ethers.getSigners();

    // Requires a configured strategy adapter so router.harvest() returns netAssets and triggers accrueFor
    const adapterAddr: string | undefined = (stake as any).MockStrategyAdapter;
    if (!adapterAddr) {
      console.log("[Staking] No strategy adapter configured; skipping streaming accrual test");
    } else {
      // Simulate fresh yield to adapter and harvest to stream funds
      const yieldAmt = ethers.parseUnits("60", 18);
      await (await asset.transfer(adapterAddr, yieldAmt)).wait();
      await (await farm.harvest()).wait();

      const cfg = await payout.getConfig();
      const epoch = Number(cfg.epoch);
      await advanceTime(Math.floor(epoch / 2));

      // Owner half-epoch claim
      const claimableOwnerMid = await payout.claimable(ownerRecipient);
      console.log("ownerRecipient claimable (mid)", fmt(bn(claimableOwnerMid)));
      if (!(bn(claimableOwnerMid) > 0n)) throw new Error("expected vested amount by mid-epoch");
      const balOwnerBefore = await asset.balanceOf(ownerRecipient);
      await (await payout.connect(farmOwner).claim(ownerRecipient)).wait();
      const balOwnerAfter = await asset.balanceOf(ownerRecipient);
      const claimedMid = bn(balOwnerAfter) - bn(balOwnerBefore);
      console.log("ownerRecipient claimed (mid)=", fmt(claimedMid));

      // Protocol (if any) claim
      const protoClaimMid = await payout.claimable(protocolOwner.address);
      if (bn(protoClaimMid) > 0n) {
        const balPBef = await asset.balanceOf(protocolOwner.address);
        await (await payout.connect(protocolOwner).claim(protocolOwner.address)).wait();
        const balPAft = await asset.balanceOf(protocolOwner.address);
        console.log("protocol claimed (mid)=", fmt(bn(balPAft) - bn(balPBef)));
      }

      // End of epoch claim remainder
      await advanceTime(epoch);
      const balOwnerB2 = await asset.balanceOf(ownerRecipient);
      await (await payout.connect(farmOwner).claim(ownerRecipient)).wait();
      const balOwnerA2 = await asset.balanceOf(ownerRecipient);
      console.log("ownerRecipient claimed (final)=", fmt(bn(balOwnerA2) - bn(balOwnerB2)));
    }
  }

  // Ensure router has at least one allocation; if a MockStrategyAdapter is present in stack, set 100% allocation
  async function ensureAllocations(name: string, stack: any) {
    const { router } = await getFarmStack(stack);
    const allocs = await (router as any).allocations();
    const ids: string[] = allocs[0];
    if (ids.length > 0) return true;
    const adapterAddr: string | undefined = (stack as any).MockStrategyAdapter;
    if (!adapterAddr) {
      console.log(`[${name}] No allocations and no adapter available; will skip allocate/deallocate tests`);
      return false;
    }
    console.log(`[${name}] setting 100% allocation to adapter ${adapterAddr}`);
    const id = (hre as any).ethers.id("ADAPTER:MOCK");
    await (router as any).setAllocations([id], [adapterAddr], [10000]);
    return true;
  }

  // (streaming accrual and claim tests will run after section 3)

  function bn(x: any) { return BigInt(x); }
  function fmt(n: bigint) { return n.toString(); }

  async function expectEq(actual: any, expected: any, label: string) {
    const a = typeof actual === "bigint" ? actual : bn(actual);
    const e = typeof expected === "bigint" ? expected : bn(expected);
    if (a !== e) throw new Error(`${label} mismatch: ${a} != ${e}`);
    console.log("✔", label, "=", e.toString());
  }
  async function expectAddr(actual: string, expected: string, label: string) {
    if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} mismatch: ${actual} != ${expected}`);
    console.log("✔", label, "=", expected);
  }
  async function expectRevert(p: Promise<any>, label: string) {
    let reverted = false;
    try { await p; } catch { reverted = true; }
    if (!reverted) throw new Error(`${label} did not revert`);
    console.log("✔", label, "reverted as expected");
  }

  async function advanceTime(seconds: number) {
    await (hre as any).network.provider.send("evm_increaseTime", [seconds]);
    await (hre as any).network.provider.send("evm_mine");
  }

  // Ensure router.farm and payoutPolicy.farm are correctly wired to this farm
  async function ensureModuleWiring(name: string, stack: any) {
    const { farm, router, payout } = await getFarmStack(stack);
    const farmAddr = await farm.getAddress();
    const routerFarm = await (router as any).farm();
    if (routerFarm.toLowerCase() !== farmAddr.toLowerCase()) {
      console.log(`[${name}] wiring router.setFarm ->`, farmAddr);
      await (await (router as any).setFarm(farmAddr)).wait();
    }
    const payoutFarm = await (payout as any).farm();
    if (payoutFarm.toLowerCase() !== farmAddr.toLowerCase()) {
      console.log(`[${name}] wiring payout.setFarm ->`, farmAddr);
      await (await (payout as any).setFarm(farmAddr)).wait();
    }
  }

  // --- 1) Wiring & Config checks ---
  for (const [name, stack] of [["Staking", stake], ["Lending", lend]] as const) {
    console.log(`\n[${name}] Wiring & config checks`);
    const { farm, router, payout, lockup, reg } = await getFarmStack(stack);

    await expectAddr(await farm.asset(), assetAddr, `${name}: farm.asset`);
    await expectAddr(await farm.router(), await router.getAddress(), `${name}: farm.router`);
    await expectAddr(await farm.payoutPolicy(), await payout.getAddress(), `${name}: farm.payoutPolicy`);
    await expectAddr(await farm.lockupPolicy(), await lockup.getAddress(), `${name}: farm.lockupPolicy`);
    await expectAddr(await farm.stakeholderRegistry(), await reg.getAddress(), `${name}: farm.stakeholderRegistry`);

    await expectAddr(await router.asset(), assetAddr, `${name}: router.asset`);

    const pcfg = await payout.getConfig();
    console.log(`${name}: payout cfg`, pcfg);
    const lcfg = await lockup.getLockConfig();
    console.log(`${name}: lock cfg`, lcfg);

    await expectAddr(await reg.protocolCore(), coreAddr, `${name}: registry.protocolCore`);
    const splits = await reg.getSplits();
    await expectEq(bn(splits.lpBps), 7000n, `${name}: registry.splits.lpBps`);
    await expectEq(bn(splits.ownerBps), 2500n, `${name}: registry.splits.ownerBps`);
    await expectEq(bn(splits.verifierBps), 500n, `${name}: registry.splits.verifierBps`);
  }

  // --- 1b) Ownership checks ---
  console.log(`\n[Ownership] owner() and farm-owner approvals`);
  const core = await ethers.getContractAt("ProtocolCore", coreAddr);
  await expectAddr(await core.owner(), data.deployer, `ProtocolCore.owner`);
  const isApprovedOwner = await core.approvedFarmOwners(data.deployer);
  if (!isApprovedOwner) throw new Error(`ProtocolCore: deployer not approved farm owner`);
  console.log("✔ ProtocolCore.approvedFarmOwners[deployer] = true");

  for (const [name, stack] of [["Staking", stake], ["Lending", lend]] as const) {
    const { farm, router, payout, lockup, reg } = await getFarmStack(stack);
    await expectAddr(await farm.owner(), data.deployer, `${name}: BaseFarm.owner`);
    await expectAddr(await router.owner(), data.deployer, `${name}: StrategyRouter.owner`);
    await expectAddr(await payout.owner(), data.deployer, `${name}: PayoutPolicy.owner`);
    await expectAddr(await lockup.owner(), data.deployer, `${name}: LockupPolicy.owner`);
    await expectAddr(await reg.owner(), data.deployer, `${name}: StakeholderRegistry.owner`);
  }

  // --- 2) Reward policy behavior (interface-level) ---
  console.log(`\n[Policy] onHarvest behavior checks (no token transfer, interface only)`);
  {
    const { payout: sp } = await getFarmStack(stake);
    const { payout: lp } = await getFarmStack(lend);
    const testAmt = ethers.parseUnits("100", 18);
    const rs = await sp.onHarvest.staticCall(testAmt);
    await (await sp.onHarvest(testAmt)).wait();
    console.log("Staking onHarvest(100): streamed=", fmt(rs[0]), "compounded=", fmt(rs[1]));
    if (!(bn(rs[0]) > 0n && bn(rs[1]) > 0n)) throw new Error("Streaming policy should split into streamed & compounded");

    const rl = await lp.onHarvest.staticCall(testAmt);
    await (await lp.onHarvest(testAmt)).wait();
    console.log("Lending onHarvest(100): streamed=", fmt(rl[0]), "compounded=", fmt(rl[1]));
    if (!(bn(rl[0]) === 0n && bn(rl[1]) === bn(testAmt))) throw new Error("Lockup policy should compound LP fully");
  }

  // --- 3) End-user flows: PPS change via simulated yield & lockup penalty; mint/redeem parity ---
  for (const [name, stack] of [["Staking", stake], ["Lending", lend]] as const) {
    console.log(`\n[${name}] End-user flow tests`);
    const { farm, lockup, payout, router } = await getFarmStack(stack);

    // Ensure router/payout wired to this farm before ops
    await ensureModuleWiring(name, stack);

    const sharesAddr = await farm.shareToken();
    const shares = await ethers.getContractAt("ERC20", sharesAddr);

    // Ensure some initial deposit
    const supplyBefore = await shares.totalSupply();
    if (bn(supplyBefore) === 0n) {
      const depositAmt = ethers.parseUnits("1000", 18);
      await (await asset.approve(await farm.getAddress(), depositAmt)).wait();
      await (await farm.deposit(depositAmt, owner.address)).wait();
    }

    const userShares = await shares.balanceOf(owner.address);
    const ppsBefore = (await farm.convertToAssets(ethers.parseUnits("1", 18)));
    console.log(`${name}: PPS before=`, fmt(bn(ppsBefore)));
    
    // Allocate some funds to strategy if allocations/adapters exist
    const idle = await asset.balanceOf(await farm.getAddress());
    const minAlloc = ethers.parseUnits("200", 18);
    if (bn(idle) < bn(minAlloc)) {
      // top up idle
      const topup = minAlloc - bn(idle);
      await (await asset.approve(await farm.getAddress(), topup)).wait();
      await (await farm.deposit(topup, owner.address)).wait();
    }
    const hasAlloc = await ensureAllocations(name, stack);
    if (hasAlloc) {
      await (await farm.allocateToStrategies(minAlloc)).wait();
    } else {
      console.log(`[${name}] skipping allocateToStrategies due to no allocations`);
    }

    // Simulate yield: send assets directly to mock adapter (if present), else to vault as fallback
    const adapterAddr: string | undefined = (stack as any).MockStrategyAdapter;
    const yieldAmt = ethers.parseUnits("50", 18);
    const yieldTarget = adapterAddr ? adapterAddr : await farm.getAddress();
    await (await asset.transfer(yieldTarget, yieldAmt)).wait();

    // If yield was sent to adapter, harvest it to vault; else it is already in vault
    if (adapterAddr) {
      await (await farm.harvest()).wait();
    } else {
      console.log(`[${name}] no adapter configured; yield sent directly to farm`);
    }
    // Assert payout policy streamed/compounded breakdown for netAssets
    const harvestNet = await payout.onHarvest.staticCall(yieldAmt);
    const [streamed, compounded] = harvestNet;
    console.log(`${name}: payout onHarvest(yield): streamed=`, fmt(bn(streamed)), "compounded=", fmt(bn(compounded)));
    if (bn(streamed) + bn(compounded) !== bn(yieldAmt)) throw new Error(`${name}: payout split should equal yieldAmt`);

    const ppsAfter = (await farm.convertToAssets(ethers.parseUnits("1", 18)));
    console.log(`${name}: PPS after=`, fmt(bn(ppsAfter)));
    if (!(bn(ppsAfter) > bn(ppsBefore))) throw new Error(`${name}: PPS should increase after yield`);

    // Deallocation path test: pull back part of allocated funds
    const beforeIdle = await asset.balanceOf(await farm.getAddress());
    const deallocAmt = ethers.parseUnits("100", 18);
    if (hasAlloc) {
      await (await farm.deallocateFromStrategies(deallocAmt)).wait();
    } else {
      console.log(`[${name}] skipping deallocateFromStrategies due to no allocations`);
    }
    const afterIdle = await asset.balanceOf(await farm.getAddress());
    if (hasAlloc) {
      if (!(bn(afterIdle) >= bn(beforeIdle) + bn(deallocAmt))) {
        throw new Error(`${name}: deallocation should increase idle by requested amount`);
      }
    } else {
      console.log(`[${name}] deallocation assertion skipped (no allocations)`);
    }

    // Secondary user mint/redeem parity around current PPS
    const mintShares = ethers.parseUnits("100", 18);
    const mintAssets = await farm.convertToAssets(mintShares);
    // fund user2 with required assets
    await (await asset.transfer(user2.address, mintAssets)).wait();
    await (await asset.connect(user2).approve(await farm.getAddress(), mintAssets)).wait();
    await (await farm.connect(user2).mint(mintShares, user2.address)).wait();
    const redeemAssetsQuote = await farm.convertToAssets(mintShares);
    // For staking, redeem should return full quoted; for lending, penalty may reduce received if locked
    const balBeforeRedeem = await asset.balanceOf(user2.address);
    await (await farm.connect(user2).redeem(mintShares, user2.address, user2.address)).wait();
    const balAfterRedeem = await asset.balanceOf(user2.address);
    const receivedRedeem = bn(balAfterRedeem) - bn(balBeforeRedeem);
    if (name === "Staking") {
      if (receivedRedeem !== bn(redeemAssetsQuote)) throw new Error("Staking: redeem should equal quote (no lockup)");
    } else {
      if (!(receivedRedeem <= bn(redeemAssetsQuote))) throw new Error("Lending: redeem should be <= quote due to penalty");
    }

    // Lockup-specific early withdrawal test for Lending only
    if (name === "Lending") {
      const withdrawAssets = ethers.parseUnits("200", 18);
      // Ensure enough idle liquidity
      const idleNow = await asset.balanceOf(await farm.getAddress());
      if (bn(idleNow) < bn(withdrawAssets)) {
        const shortfall = bn(withdrawAssets) - bn(idleNow);
        await (await farm.deallocateFromStrategies(shortfall)).wait();
      }
      const balBefore = await asset.balanceOf(owner.address);
      await (await farm.withdraw(withdrawAssets, owner.address, owner.address)).wait();
      const balAfter = await asset.balanceOf(owner.address);
      const received = bn(balAfter) - bn(balBefore);
      console.log("Lending early-withdraw received=", fmt(received));
      if (!(received < bn(withdrawAssets))) throw new Error("Lending: expected penalty to reduce received amount");

      const li = await lockup.lockInfo(owner.address);
      console.log("Lending lock info:", li);
    }
  }

  // --- 4) Farm owner controls ---
  for (const [name, stack] of [["Staking", stake], ["Lending", lend]] as const) {
    console.log(`\n[${name}] Farm owner controls`);
    const { farm, router, payout, lockup, reg } = await getFarmStack(stack);

    // Non-owner should revert on owner-only
    await expectRevert(farm.connect(nonOwner).pause(), `${name}: nonOwner pause()`);
    await expectRevert(payout.connect(nonOwner).setConfig(await payout.getConfig()), `${name}: nonOwner setConfig()`);
    await expectRevert(lockup.connect(nonOwner).setLockConfig(await lockup.getLockConfig()), `${name}: nonOwner setLockConfig()`);
    const sp = await reg.getSplits();
    await expectRevert(reg.connect(nonOwner).setSplits(sp.lpBps, sp.ownerBps, sp.verifierBps), `${name}: nonOwner setSplits()`);

    // Owner can pause/unpause
    await (await farm.pause()).wait();
    // While paused, deposit/mint should revert (withdraw/redeem not paused in current implementation)
    const testAmt = ethers.parseUnits("10", 18);
    await expectRevert(farm.deposit(testAmt, owner.address), `${name}: deposit paused`);
    await expectRevert(farm.mint(testAmt, owner.address), `${name}: mint paused`);
    await (await farm.unpause()).wait();

    // Owner can tweak splits
    await (await reg.setSplits(6900, 2600, 500)).wait();
    const sp2 = await reg.getSplits();
    await expectEq(bn(sp2.lpBps), 6900n, `${name}: splits updated`);
    // revert back to defaults
    await (await reg.setSplits(7000, 2500, 500)).wait();

    // Owner can re-set module addresses to current values (no-op but exercises access)
    await (await farm.setPayoutPolicy(await payout.getAddress())).wait();
    await (await farm.setLockupPolicy(await lockup.getAddress())).wait();
    await (await farm.setStakeholderRegistry(await reg.getAddress())).wait();
    await (await farm.setStrategyRouter(await router.getAddress())).wait();
  }

  // --- 5) Dashboard-friendly views ---
  for (const [name, stack] of [["Staking", stake], ["Lending", lend]] as const) {
    console.log(`\n[${name}] Dashboard view`);
    const { farm, router, lockup, payout, reg } = await getFarmStack(stack);

    const idle = await asset.balanceOf(await farm.getAddress());
    const tvl = await farm.totalAssets();

    const shareTokenAddr = await farm.shareToken();
    const shareToken = await ethers.getContractAt("ERC20", shareTokenAddr);
    const supply = await shareToken.totalSupply();
    const pps = await farm.convertToAssets(ethers.parseUnits("1", 18));
    const lastHarvestAt = await payout.lastHarvestAt();
    const verifiers = await reg.activeVerifiers();

    console.log({
      farm: await farm.getAddress(),
      asset: assetAddr,
      idle: fmt(bn(idle)),
      tvl: fmt(bn(tvl)),
      totalShares: fmt(bn(supply)),
      pps1e18: fmt(bn(pps)),
      lastHarvestAt: fmt(bn(lastHarvestAt)),
      activeVerifiers: verifiers,
    });

    const allocs = await router.allocations();
    const ids: string[] = allocs[0];
    const adapters: string[] = allocs[1];
    const bps: bigint[] = allocs[2];
    console.log(`Allocations count: ${ids.length}`);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const adapter = adapters[i];
      const b = bps[i];
      let adapterTvl: string | null = null;
      try {
        const a = await ethers.getContractAt("IStrategyAdapter", adapter);
        const ta = await a.totalAssets();
        adapterTvl = fmt(bn(ta));
      } catch {
        adapterTvl = "n/a"; // adapter not deployed or interface not available
      }
      console.log(`  - id=${id} adapter=${adapter} bps=${b.toString()} adapterTVL=${adapterTvl}`);
    }

    const lcfg = await lockup.getLockConfig();
    console.log(`${name}: lock config summary:`, lcfg);
  }

  // --- 6) ShareToken transferability and fee tests ---
  console.log(`\n[ShareToken] transferability and fee tests`);
  // Staking: transfers disabled
  {
    const name = "Staking" as const;
    const { farm } = await getFarmStack(stake);
    const shareTokenAddr = await farm.shareToken();
    const shares = await ethers.getContractAt("ShareToken", shareTokenAddr);
    await (await shares.setTransferable(false)).wait();
    await expectRevert(shares.transfer((await ethers.getSigners())[2].address, ethers.parseUnits("1", 18)), `${name}: transfer disabled`);
  }

  // Lending: transfers enabled with fee and protocol rake
  {
    const name = "Lending" as const;
    const { farm } = await getFarmStack(lend);
    const shareTokenAddr = await farm.shareToken();
    const shares = await ethers.getContractAt("ShareToken", shareTokenAddr);
    await (await shares.setTransferable(true)).wait();
    console.log(`[${name}] enabling transfers on ShareToken`);

    // Ensure owner has some shares to transfer
    let ownerBal = await shares.balanceOf((await ethers.getSigners())[0].address);
    if (bn(ownerBal) < bn(ethers.parseUnits("200", 18))) {
      const need = ethers.parseUnits("200", 18) - bn(ownerBal);
      await (await asset.approve(await farm.getAddress(), need)).wait();
      await (await farm.deposit(need, (await ethers.getSigners())[0].address)).wait();
      ownerBal = await shares.balanceOf((await ethers.getSigners())[0].address);
    }

    // Configure fee = 10%; feeReceiver=farmOwner (owner/sender); protocol receiver=protocolOwner (a distinct signer) taking 20% of fee
    const [farmOwner, protocolOwner, recipient] = await ethers.getSigners();
    await (await shares.setTransferFeeBps(1000)).wait(); // 10%
    await (await shares.setFeeReceiver(farmOwner.address)).wait(); // farm owner
    await (await shares.setProtocolFee(protocolOwner.address, 2000)).wait(); // protocol owner gets 20% of fee
    console.log(`[${name}] fee config -> feeBps=1000, feeReceiver=farmOwner(${farmOwner.address}), protocolReceiver=${protocolOwner.address}, protocolRakeBps=2000`);

    const sendAmt = ethers.parseUnits("100", 18);
    const fee = sendAmt / 10n; // 10%
    const protocolCut = fee * 20n / 100n; // 20% of fee
    const ownerCut = fee - protocolCut;
    const net = sendAmt - fee;
    console.log(`[${name}] transfer test -> send=${sendAmt.toString()} fee=${fee.toString()} ownerCut=${ownerCut.toString()} protocolCut=${protocolCut.toString()} net=${net.toString()}`);

    const sender = farmOwner;
    const balSenderBefore = await shares.balanceOf(farmOwner.address);
    const balRecipientBefore = await shares.balanceOf(recipient.address);
    const balProtBefore = await shares.balanceOf(protocolOwner.address);

    await (await shares.transfer(recipient.address, sendAmt)).wait();

    const balSenderAfter = await shares.balanceOf(sender.address);
    const balRecipientAfter = await shares.balanceOf(recipient.address);
    const balProtAfter = await shares.balanceOf(protocolOwner.address);

    const dRecipient = bn(balRecipientAfter) - bn(balRecipientBefore);
    const dProtocol = bn(balProtAfter) - bn(balProtBefore);
    const dSender = bn(balSenderBefore) - bn(balSenderAfter);
    console.log(`[${name}] deltas -> recipient=+${dRecipient.toString()} protocol=+${dProtocol.toString()} sender=-${dSender.toString()}`);

    // Recipient gets net (protocol rake goes to protocol owner)
    if (dRecipient !== bn(net)) {
      throw new Error(`${name}: recipient should receive net when protocol receiver != recipient`);
    }
    // Protocol owner receives protocolCut
    if (dProtocol !== bn(protocolCut)) {
      throw new Error(`${name}: protocol owner should receive protocolCut`);
    }
    // Sender loses sendAmt but is credited ownerCut as feeReceiver; net debit = sendAmt - ownerCut
    if (dSender !== bn(sendAmt - ownerCut)) {
      throw new Error(`${name}: sender net debit should be sendAmt - ownerCut`);
    }
    console.log(`✔ ${name}: fee transfer validated (recipient=net, protocol=protocolCut, sender debited sendAmt-ownerCut)`);
  }

  console.log("\nE2E checks completed.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
