import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Football Trading V1',
  description: 'Minimal live football trading scanner',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
