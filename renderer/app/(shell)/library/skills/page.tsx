// 스킬 라이브러리 — V1에서 채워질 자리.
"use client";
import { useT } from "@/lib/i18n";

export default function LibrarySkillsPage() {
  const { t } = useT();
  return (
    <section style={{ padding: "40px 32px", maxWidth: 720, margin: "0 auto" }}>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 18, marginTop: 0 }}>
        {t("library.skills.title")}
      </h2>
      <p style={{ color: "var(--muted-deep)", fontSize: 13, lineHeight: 1.6 }}>
        {t("library.skills.desc")}
      </p>
      <div
        className="glass-strong"
        style={{
          marginTop: 16,
          padding: 16,
          borderRadius: "var(--radius-md)",
          fontSize: 12,
          color: "var(--ink-soft)",
        }}
      >
        {t("library.skills.coming")}
      </div>
    </section>
  );
}
