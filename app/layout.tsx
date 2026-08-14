import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "Common Days — Find the break everyone shares",
    description: "Compare school academic calendars and find the days your whole group has off.",
    openGraph: {
      title: "Common Days",
      description: "Find the break everyone actually shares.",
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "Common Days calendar comparison" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Common Days",
      description: "Find the break everyone actually shares.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
