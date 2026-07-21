import Image from "next/image";

export function BracLogo({ size = 28 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <Image
        src="/brac-logo.png"
        alt="BRAC"
        width={size * 2.8}
        height={size}
        style={{ objectFit: "contain" }}
        priority
      />
      <div
        className="text-xs font-medium tracking-wide"
        style={{ color: "var(--text-muted)" }}
      >
        Policy Assistant
      </div>
    </div>
  );
}
