import { ImageResponse } from "next/og";

export const alt = "pymthouse — Identity & Payment Infrastructure";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 72,
          background: "linear-gradient(145deg, #09090b 0%, #18181b 55%, #052e16 100%)",
          color: "#fafafa",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            marginBottom: 32,
          }}
        >
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(52, 211, 153, 0.12)",
              border: "1px solid rgba(52, 211, 153, 0.35)",
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            <span style={{ color: "#34d399" }}>p</span>
            <span style={{ color: "#fafafa" }}>h</span>
          </div>
          <div style={{ display: "flex", fontSize: 56, fontWeight: 700, letterSpacing: "-0.03em" }}>
            <span style={{ color: "#34d399" }}>pymt</span>
            <span style={{ color: "#fafafa" }}>house</span>
          </div>
        </div>
        <div
          style={{
            fontSize: 34,
            fontWeight: 600,
            lineHeight: 1.25,
            maxWidth: 900,
            color: "#e4e4e7",
          }}
        >
          Identity &amp; payment infrastructure for Livepeer AI apps
        </div>
        <div
          style={{
            marginTop: 20,
            fontSize: 24,
            lineHeight: 1.4,
            maxWidth: 920,
            color: "#a1a1aa",
          }}
        >
          OIDC authentication, usage metering, and managed payment signing — so you ship features, not infrastructure.
        </div>
      </div>
    ),
    size,
  );
}
