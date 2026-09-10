import { ImageResponse } from "next/og";

export const alt = "ImmoJudis — les enchères immobilières en toute clarté";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "linear-gradient(135deg, #edf6fb 0%, #fff9ef 55%, #e9f4ef 100%)",
        color: "#132238",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "center",
        padding: "72px",
        textAlign: "center",
        width: "100%",
      }}
    >
      <div style={{ color: "#b77931", display: "flex", fontSize: 30, letterSpacing: 5 }}>
        IMMOJUDIS
      </div>
      <div style={{ display: "flex", fontSize: 72, fontWeight: 700, marginTop: 30 }}>
        Les enchères immobilières,
      </div>
      <div style={{ color: "#0f766e", display: "flex", fontSize: 72, fontWeight: 700 }}>
        en toute clarté.
      </div>
      <div style={{ color: "#526170", display: "flex", fontSize: 28, marginTop: 38 }}>
        Rapports d’opportunité · Comparables DVF · Mise maximale
      </div>
    </div>,
    size,
  );
}
