"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export interface SignerCliSenderInfo {
  deposit: string;
  withdrawRound: string;
  reserve: {
    fundsRemaining: string;
    claimedInCurrentRound: string;
  };
}

export interface SignerCliStatusPayload {
  reachable: boolean;
  senderInfo: SignerCliSenderInfo | null;
  ethBalance: string | null;
  tokenBalance: string | null;
  fetchedAt: string;
}

type SignerCliContextValue = {
  data: SignerCliStatusPayload | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const SignerCliContext = createContext<SignerCliContextValue | null>(null);

export function SignerCliStatusProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [data, setData] = useState<SignerCliStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/signer/cli-status");
      if (res.ok) {
        setData(await res.json());
      } else {
        setData({
          reachable: false,
          senderInfo: null,
          ethBalance: null,
          tokenBalance: null,
          fetchedAt: new Date().toISOString(),
        });
      }
    } catch {
      setData((prev) =>
        prev ?? {
          reachable: false,
          senderInfo: null,
          ethBalance: null,
          tokenBalance: null,
          fetchedAt: new Date().toISOString(),
        },
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => {
      void refresh();
    }, 15000);
    return () => clearInterval(poll);
  }, [refresh]);

  const value = useMemo(
    () => ({
      data,
      loading,
      refresh,
    }),
    [data, loading, refresh],
  );

  return (
    <SignerCliContext.Provider value={value}>
      {children}
    </SignerCliContext.Provider>
  );
}

export function useSignerCliStatus(): SignerCliContextValue {
  const ctx = useContext(SignerCliContext);
  if (!ctx) {
    throw new Error(
      "useSignerCliStatus must be used within SignerCliStatusProvider",
    );
  }
  return ctx;
}
