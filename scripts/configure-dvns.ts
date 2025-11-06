import hre from "hardhat";

const CONFIG_TYPE_ULN = 2;

const ENDPOINT_ABI = [
  "function getSendLibrary(address oapp, uint32 eid) view returns (address)",
  "function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] calldata params)"
];

interface NetworkConfig {
  token: string;
  endpoint: string;
  destEid: number;
  requiredDVNs: string[];
  confirmations: number;
}

const CONFIGS: Record<string, NetworkConfig> = {
  sepolia: {
    token: "0xB4806C1DcD25ca46f1bA6a3a20eb7869fcC9d8B1",
    endpoint: process.env.LZ_ENDPOINT_SEPOLIA ?? "0x6EDCE65403992e310A62460808c4b910D972f10f",
    destEid: 40245,
    requiredDVNs: ["0x8eebf8b423B73bFCa51a1Db4B7354AA0bFCA9193"],
    confirmations: 1
  },
  "base-sepolia": {
    token: "0xD1a055200791584c64022d664042711b583FB93B",
    endpoint: process.env.LZ_ENDPOINT_BASE_SEPOLIA ?? "0x6EDCE65403992e310A62460808c4b910D972f10f",
    destEid: 40161,
    requiredDVNs: ["0x9eCf72299027e8AeFee5DC5351D6d92294F46d2b"],
    confirmations: 1
  }
};

async function main() {
  const { ethers, network } = hre as any;
  const cfg = CONFIGS[network.name];
  if (!cfg) {
    throw new Error(`No DVN config preset for network ${network.name}`);
  }

  const [signer] = await ethers.getSigners();
  console.log("Network:", network.name, "Signer:", await signer.getAddress());
  console.log("Token:", cfg.token);
  console.log("Endpoint:", cfg.endpoint);
  console.log("Dest EID:", cfg.destEid);
  console.log("Required DVNs:", cfg.requiredDVNs);

  const endpoint = new ethers.Contract(cfg.endpoint, ENDPOINT_ABI, signer);
  const sendLib: string = await endpoint.getSendLibrary(cfg.token, cfg.destEid);
  console.log("Send library:", sendLib);

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint64", "uint8", "uint8", "uint8", "address[]", "address[]"],
    [
      BigInt(cfg.confirmations),
      cfg.requiredDVNs.length,
      0,
      0,
      cfg.requiredDVNs,
      []
    ]
  );

  const params = [{ eid: cfg.destEid, configType: CONFIG_TYPE_ULN, config: encoded }];
  const tx = await endpoint.setConfig(cfg.token, sendLib, params);
  console.log("setConfig tx:", tx.hash);
  await tx.wait();
  console.log("DVN configuration applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
