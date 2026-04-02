import { ethers } from "hardhat";

async function main() {
  const [deployer, alice, bob] = await ethers.getSigners();

  const tokenFactory = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
  const oracleFactory = await ethers.getContractFactory("contracts/v3/test/MockOracle.sol:MockOracle");
  const registryFactory = await ethers.getContractFactory("contracts/test/MockModuleRegistryV3.sol:MockModuleRegistryV3");
  const coreFactory = await ethers.getContractFactory("contracts/test/MockProtocolCoreOwnable.sol:MockProtocolCoreOwnable");
  const implFactory = await ethers.getContractFactory("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3");
  const proxyFactory = await ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy");

  const usdc = await tokenFactory.deploy("Mock USDC", "USDC", 6);
  await usdc.waitForDeployment();

  const oracle = await oracleFactory.deploy();
  await oracle.waitForDeployment();
  await (await oracle.setPrice(await usdc.getAddress(), ethers.parseUnits("1", 18))).wait();

  const moduleRegistry = await registryFactory.deploy(await oracle.getAddress());
  await moduleRegistry.waitForDeployment();

  const protocolCore = await coreFactory.deploy(await deployer.getAddress());
  await protocolCore.waitForDeployment();

  const implementation = await implFactory.deploy();
  await implementation.waitForDeployment();

  const initData = implFactory.interface.encodeFunctionData("initialize", [
    {
      protocolCore: await protocolCore.getAddress(),
      vaultOwner: await deployer.getAddress(),
      moduleRegistry: await moduleRegistry.getAddress(),
      feeCollector: await deployer.getAddress(),
      lendModule: ethers.ZeroAddress,
      borrowModule: ethers.ZeroAddress,
      performanceFeeBps: 1000,
      lockupSeconds: 0,
    },
    "Test Vault",
    "TVLT",
    [{ token: await usdc.getAddress(), weightBps: 10_000 }],
  ]);

  const proxy = await proxyFactory.deploy(await implementation.getAddress(), initData);
  await proxy.waitForDeployment();

  const vault = implFactory.attach(await proxy.getAddress());

  await (await usdc.mint(await alice.getAddress(), 1_000_000n)).wait();
  await (await usdc.mint(await bob.getAddress(), 100_000_000n)).wait();

  await (await usdc.connect(alice).approve(await vault.getAddress(), 1_000_000n)).wait();
  await (await vault.connect(alice).depositSingle(await usdc.getAddress(), 1_000_000n)).wait();

  await (await usdc.connect(bob).approve(await vault.getAddress(), 100_000_000n)).wait();

  const bobSharesBefore = await vault.balanceOf(await bob.getAddress());
  await (await vault.connect(bob).depositSingle(await usdc.getAddress(), 100_000_000n)).wait();
  const bobSharesAfter = await vault.balanceOf(await bob.getAddress());
  const minted = bobSharesAfter - bobSharesBefore;
  const expected = ethers.parseUnits("100", 18);

  console.log(`Bob minted shares: ${ethers.formatUnits(minted, 18)}`);
  console.log(`Expected shares:   ${ethers.formatUnits(expected, 18)}`);

  if (minted !== expected) {
    throw new Error(`Regression: expected ${expected.toString()} shares, got ${minted.toString()}`);
  }

  await (await vault.connect(alice).withdraw(await vault.balanceOf(await alice.getAddress()))).wait();
  await (await vault.connect(bob).withdraw(await vault.balanceOf(await bob.getAddress()))).wait();

  const totalSupplyAfterWithdraw = await vault.totalSupply();
  if (totalSupplyAfterWithdraw !== 1000n) {
    throw new Error(`Expected dead-shares-only state, got totalSupply=${totalSupplyAfterWithdraw.toString()}`);
  }

  await (await usdc.mint(await bob.getAddress(), 100_000_000n)).wait();
  await (await usdc.connect(bob).approve(await vault.getAddress(), 100_000_000n)).wait();

  const poisonedSharesBefore = await vault.balanceOf(await bob.getAddress());
  await (await vault.connect(bob).depositSingle(await usdc.getAddress(), 100_000_000n)).wait();
  const poisonedSharesAfter = await vault.balanceOf(await bob.getAddress());
  const poisonedMinted = poisonedSharesAfter - poisonedSharesBefore;

  console.log(`Bob minted after dead-shares reset: ${ethers.formatUnits(poisonedMinted, 18)}`);
  if (poisonedMinted !== expected) {
    throw new Error(`Dead-share reset regression: expected ${expected.toString()} shares, got ${poisonedMinted.toString()}`);
  }

  console.log("Share mint regression checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
