import { ImageResponse } from "next/og";

export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#09090b",
          borderRadius: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          <span style={{ color: "#34d399" }}>p</span>
          <span style={{ color: "#fafafa" }}>h</span>
        </div>
      </div>
    ),
    size,
  );
}
