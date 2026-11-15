"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createConfig, http, injected, WagmiProvider } from "wagmi";
import { chain, RPC_URL } from "@/lib/config";
import { AppProvider } from "@/lib/app";
import { TxProvider } from "@/lib/tx";
import { WalletProvider } from "@/lib/wallet";
import { PrivyAuth } from "@/lib/privy";
import { BrandProvider } from "@/brand/context";
import type { BrandConfig } from "@/brand/schema";
import { UiProvider } from "@/components/ui";

const wagmiConfig = createConfig({ chains: [chain], connectors: [injected()], transports: { [chain.id]: http(RPC_URL) }, ssr: true });

export default function Providers({ children, brand, real }: { children: ReactNode; brand: BrandConfig; real: boolean }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <BrandProvider brand={brand} real={real}>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <PrivyAuth>
        <WalletProvider>
          <TxProvider>
            <UiProvider><AppProvider>{children}</AppProvider></UiProvider>
          </TxProvider>
        </WalletProvider>
        </PrivyAuth>
      </QueryClientProvider>
    </WagmiProvider>
    </BrandProvider>
  );
}
