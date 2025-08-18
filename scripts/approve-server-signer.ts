import hre from "hardhat";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

async function main() {
  const network = "localhost";
  const dir = join(process.cwd(), "deployments", network);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`No deployment files in ${dir}`);
  const latest = files[files.length - 1];
  const dep = JSON.parse(readFileSync(join(dir, latest), "utf8"));
  const coreAddr: string | undefined = dep?.contracts?.ProtocolCore;
  if (!coreAddr) throw new Error("ProtocolCore address not found in deployment file");

  const approveAddr = process.env.APPROVE_ADDR;
  if (!approveAddr) throw new Error("Set APPROVE_ADDR to the address to approve");

  const [owner] = await (hre as any).ethers.getSigners();
  console.log("Owner:", await owner.getAddress());
  console.log("ProtocolCore:", coreAddr);
  console.log("Approve:", approveAddr);

  const core = await (hre as any).ethers.getContractAt("ProtocolCore", coreAddr, owner);
  const tx = await core.setApprovedFarmOwner(approveAddr, true);
  console.log("txHash", tx.hash);
  await tx.wait();
  console.log("Approved", approveAddr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
