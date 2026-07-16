import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { arcTestnet } from '@/lib/arc';
import { baseSepolia, SOURCE_CHAINS } from '@/lib/cctp';

export const wagmiConfig = createConfig({
  chains: [arcTestnet, baseSepolia],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(process.env.NEXT_PUBLIC_ARC_RPC_HTTP ?? 'https://rpc.testnet.arc.network'),
    [baseSepolia.id]: http(SOURCE_CHAINS[6].rpcUrl),
  },
  ssr: true,
});
