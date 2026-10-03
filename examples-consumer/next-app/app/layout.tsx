export const metadata = { title: "Konsumen xp" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#F6F8FA" }}>{children}</body>
    </html>
  );
}
