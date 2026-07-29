import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { readPartialCardSetCoverageWarning } from "../card-coverage-warning";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const cardSetSource = readFileSync(
  resolve(
    WEB_ROOT,
    "app/(workspace)/(focus)/card-sets/[id]/page.tsx",
  ),
  "utf8",
);
const cardDetailSource = readFileSync(
  resolve(WEB_ROOT, "app/(workspace)/(focus)/cards/[id]/page.tsx"),
  "utf8",
);
const noteEditorSource = readFileSync(
  resolve(WEB_ROOT, "components/NoteEditor.tsx"),
  "utf8",
);
const apiSource = readFileSync(resolve(WEB_ROOT, "lib/api.ts"), "utf8");
const shellSource = readFileSync(
  resolve(WEB_ROOT, "components/layout/AppShell.tsx"),
  "utf8",
);

describe("learning card set UI contract", () => {
  it("reads the M5 generation coverage report without trusting opaque ids", () => {
    const sourceUnitId = "4b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1";
    assert.deepEqual(
      readPartialCardSetCoverageWarning({
        resultCompleteness: "partial",
        excludedImages: [{
          sourceUnitId,
          imageAssetId: "1b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1",
          imageBlockId: "2b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1",
          reason: "image_provider_timeout",
        }, {
          sourceUnitId: "not-a-uuid",
          imageAssetId: "also-invalid",
          imageBlockId: "invalid",
        }],
      }),
      {
        code: "partial_generation",
        excludedImageCount: 1,
        excludedUnitIds: [sourceUnitId],
        excludedImages: [{
          sourceUnitId,
          imageAssetId: "1b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1",
          imageBlockId: "2b1ec21f-4ac3-4bc7-9a7b-f6cde1f87cc1",
          reason: "image_provider_timeout",
        }],
      },
    );
  });

  it("exposes card-set API types and lifecycle methods", () => {
    assert.ok(apiSource.includes("export interface CardSetDetailResponse"));
    assert.ok(apiSource.includes("cards: CardDetailResponse[]"));
    assert.match(
      apiSource,
      /export interface CardSetDetailResponse \{[\s\S]*nextCursor: string \| null;/,
    );
    assert.ok(apiSource.includes("export interface CardSetCardsPageResponse"));
    assert.ok(apiSource.includes("items: CardDetailResponse[]"));
    assert.ok(apiSource.includes("listCardSetCards:"));
    assert.ok(apiSource.includes("/card-sets/${id}/cards${qs}"));
    assert.ok(apiSource.includes("acceptedArtifactCount: number"));
    assert.ok(apiSource.includes("listCardSets:"));
    assert.ok(apiSource.includes("getCardSet:"));
    assert.ok(apiSource.includes("acceptCardSet:"));
    assert.ok(apiSource.includes("dismissCardSet:"));
    assert.ok(apiSource.includes("regenerateCardSet:"));
  });

  it("renders overview and section cards with partial and lifecycle affordances", () => {
    assert.ok(cardSetSource.includes('title="总览"'));
    assert.ok(cardSetSource.includes('title="章节卡"'));
    assert.ok(cardSetSource.includes("cardSet.status === \"partial_ready\""));
    assert.ok(cardSetSource.includes("readPartialCardSetCoverageWarning"));
    assert.ok(cardSetSource.includes("api.acceptCardSet"));
    assert.ok(cardSetSource.includes("api.dismissCardSet"));
    assert.ok(cardSetSource.includes("api.regenerateCardSet"));
    assert.ok(cardSetSource.includes("<StudyPaper"));
    assert.ok(cardSetSource.includes("<EvidenceRail"));
    assert.ok(cardSetSource.includes('aria-label="卡组操作"'));
    assert.ok(shellSource.includes('? "card-set-detail"'));
  });

  it("incrementally loads long card sets without replacing the current page", () => {
    assert.ok(cardSetSource.includes("const loadMoreCards = useCallback"));
    assert.ok(cardSetSource.includes("api.listCardSetCards(cardSetId"));
    assert.ok(cardSetSource.includes("cursor,"));
    assert.ok(cardSetSource.includes("appendUniqueCardSetMembers"));
    assert.ok(cardSetSource.includes("current.nextCursor !== cursor"));
    assert.ok(cardSetSource.includes("nextCursor: result.nextCursor"));
    assert.ok(cardSetSource.includes('className="card-set-pagination"'));
    assert.ok(cardSetSource.includes('loadingMore ? "正在加载…" : "加载更多"'));
    assert.ok(cardSetSource.includes("更多学习卡暂时没有加载成功"));
  });

  it("prefers the generated card set and keeps single-card fallback navigation", () => {
    const targetStart = noteEditorSource.indexOf(
      "const generatedCardHref",
    );
    const targetEnd = noteEditorSource.indexOf(
      "const hasWritableContent",
      targetStart,
    );
    const targetSource = noteEditorSource.slice(targetStart, targetEnd);
    assert.ok(
      targetSource.indexOf("result?.cardSetId")
      < targetSource.indexOf("result?.cardId"),
    );
    assert.ok(targetSource.includes("/card-sets/${generationRun.result.cardSetId}"));
    assert.ok(targetSource.includes("/cards/${generationRun.result.cardId}"));
  });

  it("links a member card back to its set and exposes sibling navigation", () => {
    assert.ok(cardDetailSource.includes("api.getCardSet(parentSetId)"));
    assert.ok(cardDetailSource.includes('aria-label="卡组内学习卡导航"'));
    assert.ok(cardDetailSource.includes("previousSetCard"));
    assert.ok(cardDetailSource.includes("nextSetCard"));
    assert.ok(cardDetailSource.includes("/card-sets/${card.cardSetId}"));
  });
});
