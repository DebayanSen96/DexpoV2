import { execSync } from 'child_process';

async function enableBigBlocks() {
  const PRIVATE_KEY = process.env.HYPERLIQUID_PRIVATE_KEY;
  if (!PRIVATE_KEY) {
    throw new Error('HYPERLIQUID_PRIVATE_KEY environment variable is required');
  }

  console.log('Enabling big blocks for Hyperliquid deployment...');

  try {
    // Use LayerZero Hyperliquid Composer to set account to use big blocks
    const command = `npx @layerzerolabs/hyperliquid-composer set-block --size big --network testnet --private-key ${PRIVATE_KEY}`;
    console.log('Running command:', command);

    const output = execSync(command, { encoding: 'utf8' });
    console.log('Command output:', output);

    console.log('✅ Big blocks enabled successfully!');
    console.log('You can now run the deployment script.');
  } catch (error: any) {
    console.error('❌ Failed to enable big blocks:', error.message);
    console.error('Error details:', error);
    throw error;
  }
}

enableBigBlocks().catch(console.error);


