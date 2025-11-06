import hre from "hardhat";

async function main() {
  const { ethers, network } = hre as any;
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("Network:", network.name, "Signer:", me);

  const BASE_EID = 40245;
  const ETH_SEPOLIA_EID = 40161;

  let tokenAddr: string;
  let dstEid: number;
  if (network.name === "base-sepolia") {
    tokenAddr = "0xD1a055200791584c64022d664042711b583FB93B";
    dstEid = ETH_SEPOLIA_EID;
  } else if (network.name === "sepolia") {
    tokenAddr = "0xB4806C1DcD25ca46f1bA6a3a20eb7869fcC9d8B1";
    dstEid = BASE_EID;
  } else {
    throw new Error("Run on base-sepolia or sepolia");
  }

  console.log("Token:", tokenAddr);
  console.log("Setting enforced options for dstEid:", dstEid);

  const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", tokenAddr);

  // Enforced options format for LayerZero V2:
  // Options type 3: [type(uint16), gas(uint128), value(uint128)]
  // We'll use type 3 with 200k gas and 0 value
  // Format: 0x0003 (type) + gas as uint128 + value as uint128
  const optionsType = "0x0003"; // Type 3
  const gas = ethers.zeroPadValue(ethers.toBeHex(200000), 16); // 200k gas as uint128
  const value = ethers.zeroPadValue("0x00", 16); // 0 value as uint128
  const enforcedOptions = optionsType + gas.slice(2) + value.slice(2);

  console.log("Enforced options:", enforcedOptions);

  // EnforcedOptionParam struct: { eid: uint32, msgType: uint16, options: bytes }
  // msgType 1 = SEND
  const enforcedOptionParam = {
    eid: dstEid,
    msgType: 1, // SEND
    options: enforcedOptions
  };

  try {
    const tx = await token.setEnforcedOptions([enforcedOptionParam]);
    console.log("setEnforcedOptions tx:", tx.hash);
    await tx.wait();
    console.log("Enforced options set successfully");
  } catch (e: any) {
    console.log("Failed to set enforced options:", e.message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
