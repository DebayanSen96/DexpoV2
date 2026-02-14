const rpc = "https://hoodi.drpc.org";
const CSM = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const NO_ID = 396;

async function call(to, data) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [{ to, data }, "latest"],
      id: 1,
    }),
  });
  return (await r.json()).result;
}

async function main() {
  const id = NO_ID.toString(16).padStart(64, "0");
  const r = await call(CSM, "0x65c14dc7" + id);
  if (!r || r === "0x") { console.log("Call failed"); return; }
  const vals = r.slice(2).match(/.{64}/g);
  console.log("NO #" + NO_ID + " state:");
  console.log("  added:", parseInt(vals[0], 16));
  console.log("  withdrawn:", parseInt(vals[1], 16));
  console.log("  deposited:", parseInt(vals[2], 16));
  console.log("  vetted:", parseInt(vals[3], 16));
  console.log("  stuck:", parseInt(vals[4], 16));
  console.log("  depositable:", parseInt(vals[5], 16));
  console.log("  enqueued:", parseInt(vals[9], 16));

  const bn = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 2 }),
  });
  const block = parseInt((await bn.json()).result, 16);
  console.log("  current block:", block, "(created at 2230872, diff:", block - 2230872, "blocks)");

  const deposited = parseInt(vals[2], 16);
  const vetted = parseInt(vals[3], 16);

  if (deposited > 0) {
    console.log("\n  DEPOSITED - validator is live on beacon chain");
  } else if (vetted === 0) {
    console.log("\n  UNVETTED - key was invalidated by DSM");
  } else {
    console.log("\n  VETTED - key is valid, waiting for deposit bot");
  }
}

main();
