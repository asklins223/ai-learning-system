"use client";

/**
 * v0.6 Card Validation Focus Route (计划 §9.1)
 *
 * Route: /cards/[id]/validate?keyPoint=...
 *
 * Independent Focus session for question-first validation.
 * Hides bottom navigation, uses 100dvh, sticky action bar.
 * No card title, claim, quote, or evidence visible during answering.
 */

import "@/app/styles/validation-focus.css";
import { useParams, useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { ValidationFocus } from "@/components/ValidationFocus";

export default function CardValidatePage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const cardId = params.id;
  const keyPointId = searchParams.get("keyPoint") ?? undefined;

  const exitHref = `/cards/${cardId}`;

  return (
    <ValidationFocus
      cardId={cardId}
      keyPointId={keyPointId}
      exitHref={exitHref}
      exitLabel="返回学习卡"
      onExit={() => router.push(exitHref)}
    />
  );
}
