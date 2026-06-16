import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "知识循环",
  description: "本地学习循环与公开知识库。"
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <header>
          <nav aria-label="主导航">
            <a href="/">首页</a> | <a href="/learn">学习</a> | <a href="/wiki">公开知识库</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
