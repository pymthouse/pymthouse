declare module "@turnkey/react-wallet-kit/auth-component" {
  import type { ComponentType } from "react";

  export type AuthComponentProps = {
    sessionKey?: string;
    logo?: string;
    logoClassName?: string;
    title?: string;
  };

  export const AuthComponent: ComponentType<AuthComponentProps>;
}
