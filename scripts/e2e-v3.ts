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

  async function getVaultStack(stack: any) {
    const vault = await ethers.getContractAt("BaseVault", stack.BaseVault);
    const router = await ethers.getContractAt("StrategyRouter", stack.StrategyRouter);
    const payout = await ethers.getContractAt("PayoutPolicy", stack.PayoutPolicy);
    const lockup = await ethers.getContractAt("LockupPolicy", stack.LockupPolicy);
    const reg = await ethers.getContractAt("StakeholderRegistry", stack.StakeholderRegistry);
    return { vault, router, payout, lockup, reg };
  }

  // --- 3b) Streaming accrual and claim tests (Staking) ---
  console.log(`\n[Staking] Streaming accrual and claim tests`);
  {
    const { vault, payout, reg } = await getVaultStack(stake);
    const registryAddr = await reg.getAddress();
    const ownerRecipient: string = await reg.ownerRecipient();
    console.log("StakeholderRegistry:", registryAddr, "ownerRecipient:", ownerRecipient);
    const [farmOwner, protocolOwner] = await ethers.getSigners();

    // Simulate fresh yield to accrue into streaming buckets
    const adapterAddr: string | undefined = (stake as any).MockStrategyAdapter;
    const yieldAmt = ethers.parseUnits("60", 18);
    await (await asset.transfer(adapterAddr ?? await vault.getAddress(), yieldAmt)).wait();
    if (adapterAddr) await (await vault.harvest()).wait();

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

  // --- 1) Wiring & Config checks ---
  for (const [name, stack] of [["Staking", stake], ["Lending", lend]] as const) {
    console.log(`\n[${name}] Wiring & config checks`);
    const { vault, router, payout, lockup, reg } = await getVaultStack(stack);

    await expectAddr(await vault.asset(), assetAddr, `${name}: vault.asset`);
    await expectAddr(await vault.router(), await router.getAddress(), `${name}: vault.router`);
    await expectAddr(await vault.payoutPolicy(), await payout.getAddress(), `${name}: vault.payoutPolicy`);
    await expectAddr(await vault.lockupPolicy(), await lockup.getAddress(), `${name}: vault.lockupPolicy`);
    await expectAddr(await vault.stakeholderRegistry(), await reg.getAddress(), `${name}: vault.stakeholderRegistry`);

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
    const { vault, router, payout, lockup, reg } = await getVaultStack(stack);
    await expectAddr(await vault.owner(), data.deployer, `${name}: BaseVault.owner`);
    await expectAddr(await router.owner(), data.deployer, `${name}: StrategyRouter.owner`);
    await expectAddr(await payout.owner(), data.deployer, `${name}: PayoutPolicy.owner`);
    await expectAddr(await lockup.owner(), data.deployer, `${name}: LockupPolicy.owner`);
    await expectAddr(await reg.owner(), data.deployer, `${name}: StakeholderRegistry.owner`);
  }

  // --- 2) Reward policy behavior (interface-level) ---
  console.log(`\n[Policy] onHarvest behavior checks (no token transfer, interface only)`);
  {
    const { payout: sp } = await getVaultStack(stake);
    const { payout: lp } = await getVaultStack(lend);
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
    const { vault, lockup, payout, router } = await getVaultStack(stack);

    const sharesAddr = await vault.shareToken();
    const shares = await ethers.getContractAt("ERC20", sharesAddr);

    // Ensure some initial deposit
    const supplyBefore = await shares.totalSupply();
    if (bn(supplyBefore) === 0n) {
      const depositAmt = ethers.parseUnits("1000", 18);
      await (await asset.approve(await vault.getAddress(), depositAmt)).wait();
      await (await vault.deposit(depositAmt, owner.address)).wait();
    }

    const userShares = await shares.balanceOf(owner.address);
    const ppsBefore = (await vault.convertToAssets(ethers.parseUnits("1", 18)));
    console.log(`${name}: PPS before=`, fmt(bn(ppsBefore)));
    
    // Allocate some funds to strategy if any idle exists
    const idle = await asset.balanceOf(await vault.getAddress());
    const minAlloc = ethers.parseUnits("200", 18);
    if (bn(idle) < bn(minAlloc)) {
      // top up idle
      const topup = minAlloc - bn(idle);
      await (await asset.approve(await vault.getAddress(), topup)).wait();
      await (await vault.deposit(topup, owner.address)).wait();
    }
    await (await vault.allocateToStrategies(minAlloc)).wait();

    // Simulate yield: send assets directly to mock adapter (if present), else to vault as fallback
    const adapterAddr: string | undefined = (stack as any).MockStrategyAdapter;
    const yieldAmt = ethers.parseUnits("50", 18);
    const yieldTarget = adapterAddr ?? await vault.getAddress();
    await (await asset.transfer(yieldTarget, yieldAmt)).wait();

    // If yield was sent to adapter, harvest it to vault; else it is already in vault
    if (adapterAddr) {
      await (await vault.harvest()).wait();
    }
    // Assert payout policy streamed/compounded breakdown for netAssets
    const harvestNet = await payout.onHarvest.staticCall(yieldAmt);
    const [streamed, compounded] = harvestNet;
    console.log(`${name}: payout onHarvest(yield): streamed=`, fmt(bn(streamed)), "compounded=", fmt(bn(compounded)));
    if (bn(streamed) + bn(compounded) !== bn(yieldAmt)) throw new Error(`${name}: payout split should equal yieldAmt`);

    const ppsAfter = (await vault.convertToAssets(ethers.parseUnits("1", 18)));
    console.log(`${name}: PPS after=`, fmt(bn(ppsAfter)));
    if (!(bn(ppsAfter) > bn(ppsBefore))) throw new Error(`${name}: PPS should increase after yield`);

    // Deallocation path test: pull back part of allocated funds
    const beforeIdle = await asset.balanceOf(await vault.getAddress());
    const deallocAmt = ethers.parseUnits("100", 18);
    await (await vault.deallocateFromStrategies(deallocAmt)).wait();
    const afterIdle = await asset.balanceOf(await vault.getAddress());
    if (!(bn(afterIdle) >= bn(beforeIdle) + bn(deallocAmt))) {
      throw new Error(`${name}: deallocation should increase idle by requested amount`);
    }

    // Secondary user mint/redeem parity around current PPS
    const mintShares = ethers.parseUnits("100", 18);
    const mintAssets = await vault.convertToAssets(mintShares);
    // fund user2 with required assets
    await (await asset.transfer(user2.address, mintAssets)).wait();
    await (await asset.connect(user2).approve(await vault.getAddress(), mintAssets)).wait();
    await (await vault.connect(user2).mint(mintShares, user2.address)).wait();
    const redeemAssetsQuote = await vault.convertToAssets(mintShares);
    // For staking, redeem should return full quoted; for lending, penalty may reduce received if locked
    const balBeforeRedeem = await asset.balanceOf(user2.address);
    await (await vault.connect(user2).redeem(mintShares, user2.address, user2.address)).wait();
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
      const idleNow = await asset.balanceOf(await vault.getAddress());
      if (bn(idleNow) < bn(withdrawAssets)) {
        const shortfall = bn(withdrawAssets) - bn(idleNow);
        await (await vault.deallocateFromStrategies(shortfall)).wait();
      }
      const balBefore = await asset.balanceOf(owner.address);
      await (await vault.withdraw(withdrawAssets, owner.address, owner.address)).wait();
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
    const { vault, router, payout, lockup, reg } = await getVaultStack(stack);

    // Non-owner should revert on owner-only
    await expectRevert(vault.connect(nonOwner).pause(), `${name}: nonOwner pause()`);
    await expectRevert(payout.connect(nonOwner).setConfig(await payout.getConfig()), `${name}: nonOwner setConfig()`);
    await expectRevert(lockup.connect(nonOwner).setLockConfig(await lockup.getLockConfig()), `${name}: nonOwner setLockConfig()`);
    const sp = await reg.getSplits();
    await expectRevert(reg.connect(nonOwner).setSplits(sp.lpBps, sp.ownerBps, sp.verifierBps), `${name}: nonOwner setSplits()`);

    // Owner can pause/unpause
    await (await vault.pause()).wait();
    // While paused, deposit/mint should revert (withdraw/redeem not paused in current implementation)
    const testAmt = ethers.parseUnits("10", 18);
    await expectRevert(vault.deposit(testAmt, owner.address), `${name}: deposit paused`);
    await expectRevert(vault.mint(testAmt, owner.address), `${name}: mint paused`);
    await (await vault.unpause()).wait();

    // Owner can tweak splits
    await (await reg.setSplits(6900, 2600, 500)).wait();
    const sp2 = await reg.getSplits();
    await expectEq(bn(sp2.lpBps), 6900n, `${name}: splits updated`);
    // revert back to defaults
    await (await reg.setSplits(7000, 2500, 500)).wait();

    // Owner can re-set module addresses to current values (no-op but exercises access)
    await (await vault.setPayoutPolicy(await payout.getAddress())).wait();
    await (await vault.setLockupPolicy(await lockup.getAddress())).wait();
    await (await vault.setStakeholderRegistry(await reg.getAddress())).wait();
    await (await vault.setStrategyRouter(await router.getAddress())).wait();
  }

  // --- 5) Dashboard-friendly views ---
  for (const [name, stack] of [["Staking", stake], ["Lending", lend]] as const) {
    console.log(`\n[${name}] Dashboard view`);
    const { vault, router, lockup, payout, reg } = await getVaultStack(stack);

    const idle = await asset.balanceOf(await vault.getAddress());
    const tvl = await vault.totalAssets();

    const shareTokenAddr = await vault.shareToken();
    const shareToken = await ethers.getContractAt("ERC20", shareTokenAddr);
    const supply = await shareToken.totalSupply();
    const pps = await vault.convertToAssets(ethers.parseUnits("1", 18));
    const lastHarvestAt = await payout.lastHarvestAt();
    const verifiers = await reg.activeVerifiers();

    console.log({
      vault: await vault.getAddress(),
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
    const { vault } = await getVaultStack(stake);
    const shareTokenAddr = await vault.shareToken();
    const shares = await ethers.getContractAt("ShareToken", shareTokenAddr);
    await (await shares.setTransferable(false)).wait();
    await expectRevert(shares.transfer((await ethers.getSigners())[2].address, ethers.parseUnits("1", 18)), `${name}: transfer disabled`);
  }

  // Lending: transfers enabled with fee and protocol rake
  {
    const name = "Lending" as const;
    const { vault } = await getVaultStack(lend);
    const shareTokenAddr = await vault.shareToken();
    const shares = await ethers.getContractAt("ShareToken", shareTokenAddr);
    await (await shares.setTransferable(true)).wait();
    console.log(`[${name}] enabling transfers on ShareToken`);

    // Ensure owner has some shares to transfer
    let ownerBal = await shares.balanceOf((await ethers.getSigners())[0].address);
    if (bn(ownerBal) < bn(ethers.parseUnits("200", 18))) {
      const need = ethers.parseUnits("200", 18) - bn(ownerBal);
      await (await asset.approve(await vault.getAddress(), need)).wait();
      await (await vault.deposit(need, (await ethers.getSigners())[0].address)).wait();
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
