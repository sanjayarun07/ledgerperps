"use client";
// Email sign-in with an embedded wallet (Privy). Optional: it is only active when NEXT_PUBLIC_PRIVY_APP_ID is set.
// Multi-factor authentication (authenticator app / passkey / SMS) is switched on in the Privy dashboard; once a user enrolls,
// Privy asks for the second factor before it signs. "Secure this wallet" below opens Privy's own enrollment dialog.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { PrivyProvider, useMfaEnrollment, usePrivy, useWallets } from "@privy-io/react-auth";
import type { Address } from "viem";
import { chain } from "./config";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

export type Eip1193 = { request(args: { method: string; params?: unknown }): Promise<unknown> };

export interface PrivyState {
  /** False when no app id is configured: the email option is hidden. */
  enabled: boolean;
  ready: boolean;
  authenticated: boolean;
  email?: string;
  address?: Address;
  provider?: Eip1193;
  /** True once the user has enrolled a second factor. */
  mfaEnrolled: boolean;
  login(): void;
  logout(): void;
  enrollMfa(): void;
}

const OFF: PrivyState = { enabled: false, ready: true, authenticated: false, mfaEnrolled: false, login() {}, logout() {}, enrollMfa() {} };
const Ctx = createContext<PrivyState>(OFF);
export const usePrivyState = () => useContext(Ctx);

function Bridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const { showMfaEnrollmentModal } = useMfaEnrollment();
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const [provider, setProvider] = useState<Eip1193>();

  useEffect(() => {
    let live = true;
    setProvider(undefined);
    if (!embedded) return;
    embedded.switchChain(chain.id).catch(() => { /* the app shows a wrong-network banner if this fails */ }).then(() => embedded.getEthereumProvider()).then((p) => { if (live) setProvider(p as Eip1193); }).catch(() => { /* provider unavailable */ });
    return () => { live = false; };
  }, [embedded]);

  const value = useMemo<PrivyState>(() => ({
    enabled: true,
    ready,
    authenticated,
    email: user?.email?.address,
    address: embedded?.address as Address | undefined,
    provider,
    mfaEnrolled: (user?.mfaMethods?.length ?? 0) > 0,
    login: () => login({ loginMethods: ["email"] }),
    logout: () => { void logout(); },
    enrollMfa: () => { void showMfaEnrollmentModal(); },
  }), [ready, authenticated, user, embedded, provider, login, logout, showMfaEnrollmentModal]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function PrivyAuth({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <>{children}</>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email"],
        defaultChain: chain,
        supportedChains: [chain],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        appearance: { theme: "dark" },
      }}
    >
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}
