import { expect } from "chai";
import { ethers } from "hardhat";

describe("Borrow Module V1", function () {
  const ADAPTER_ID = ethers.keccak256(ethers.toUtf8Bytes("MOCK_BORROW"));

  async function expectRevert(promise: Promise<unknown>, errorFragment?: string) {
    let reverted = false;
    try {
      await promise;
    } catch (error: any) {
      const message = String(error?.message || "");
      reverted = errorFragment ? message.includes(errorFragment) : true;
    }
    expect(reverted).to.equal(true);
  }

  async function deployFixture() {
    const [deployer, safe, protocolOwner, stranger] = await ethers.getSigners();

    const coreFactory = await ethers.getContractFactory("contracts/v3/test/MockProtocolCoreOwner.sol:MockProtocolCoreOwner");
    const core = await coreFactory.deploy(protocolOwner.address);
    await core.waitForDeployment();

    const oracleFactory = await ethers.getContractFactory("contracts/v3/test/MockOracle.sol:MockOracle");
    const oracle = await oracleFactory.deploy();
    await oracle.waitForDeployment();

    const tokenFactory = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
    const token = await tokenFactory.deploy("USD Coin", "USDC", 6);
    await token.waitForDeployment();

    await (await oracle.setPrice(await token.getAddress(), ethers.parseUnits("1", 18))).wait();

    const vaultFactory = await ethers.getContractFactory("contracts/v3/test/MockBorrowVault.sol:MockBorrowVault");
    const vault = await vaultFactory.deploy(safe.address, ethers.parseUnits("1000", 18));
    await vault.waitForDeployment();

    const hubFactory = await ethers.getContractFactory("contracts/v3/mainnet/modules/borrow/BorrowHub.sol:BorrowHub");
    const hub = await hubFactory.deploy(await core.getAddress(), await oracle.getAddress());
    await hub.waitForDeployment();

    const adapterFactory = await ethers.getContractFactory("contracts/v3/test/MockBorrowAdapter.sol:MockBorrowAdapter");
    const adapter = await adapterFactory.deploy();
    await adapter.waitForDeployment();

    await (await adapter.setBorrowHub(await hub.getAddress())).wait();
    await (await adapter.setTokenConfig(
      await token.getAddress(),
      true,
      5000,
      ethers.parseUnits("1000000", 6),
      0
    )).wait();
    await (await hub.addAdapter(ADAPTER_ID, await adapter.getAddress())).wait();

    return { deployer, safe, protocolOwner, stranger, token, vault, hub, adapter, core };
  }

  it("allows authorized actors (safe, protocol owner, vault) and blocks strangers", async function () {
    const { safe, protocolOwner, stranger, token, vault, hub } = await deployFixture();
    const tokenAddress = await token.getAddress();
    const vaultAddress = await vault.getAddress();

    await expectRevert(
      hub.connect(stranger).borrow(vaultAddress, tokenAddress, ethers.parseUnits("10", 6), ADAPTER_ID)
    );

    await hub.connect(safe).borrow(vaultAddress, tokenAddress, ethers.parseUnits("10", 6), ADAPTER_ID);

    await hub.connect(protocolOwner).borrow(vaultAddress, tokenAddress, ethers.parseUnits("5", 6), ADAPTER_ID);

    await vault.executeBorrow(await hub.getAddress(), tokenAddress, ethers.parseUnits("1", 6), ADAPTER_ID);
  });

  it("enforces token support, cap, and LTV guard", async function () {
    const { safe, token, vault, hub, adapter } = await deployFixture();
    const tokenAddress = await token.getAddress();
    const vaultAddress = await vault.getAddress();

    await (await adapter.setTokenConfig(tokenAddress, false, 5000, ethers.parseUnits("1000000", 6), 0)).wait();
    await expectRevert(
      hub.connect(safe).borrow(vaultAddress, tokenAddress, ethers.parseUnits("10", 6), ADAPTER_ID),
      "TokenNotSupported"
    );

    await (await adapter.setTokenConfig(tokenAddress, true, 5000, ethers.parseUnits("20", 6), 0)).wait();
    await expectRevert(
      hub.connect(safe).borrow(vaultAddress, tokenAddress, ethers.parseUnits("21", 6), ADAPTER_ID),
      "BorrowCapExceeded"
    );

    await (await adapter.setTokenConfig(tokenAddress, true, 5000, ethers.parseUnits("1000000", 6), 0)).wait();
    await (await vault.setTotalValueUsd(ethers.parseUnits("100", 18))).wait();
    await expectRevert(
      hub.connect(safe).borrow(vaultAddress, tokenAddress, ethers.parseUnits("60", 6), ADAPTER_ID),
      "SolvencyCheckFailed"
    );
  });

  it("supports partial and full repay and reports debt position value", async function () {
    const { safe, token, vault, hub } = await deployFixture();
    const tokenAddress = await token.getAddress();
    const vaultAddress = await vault.getAddress();
    const hubAddress = await hub.getAddress();

    await (await hub.connect(safe).borrow(vaultAddress, tokenAddress, ethers.parseUnits("100", 6), ADAPTER_ID)).wait();

    let positionValue = await hub.getPositionValue(vaultAddress, ethers.ZeroAddress);
    expect(positionValue).to.equal(ethers.parseUnits("100", 18));

    await (await vault.approveToken(tokenAddress, hubAddress, ethers.parseUnits("100", 6))).wait();
    await (await hub.connect(safe).repay(vaultAddress, tokenAddress, ethers.parseUnits("40", 6))).wait();

    positionValue = await hub.getPositionValue(vaultAddress, ethers.ZeroAddress);
    expect(positionValue).to.equal(ethers.parseUnits("60", 18));

    await (await hub.connect(safe).repayAll(vaultAddress, tokenAddress)).wait();
    positionValue = await hub.getPositionValue(vaultAddress, ethers.ZeroAddress);
    expect(positionValue).to.equal(0n);
  });
});
