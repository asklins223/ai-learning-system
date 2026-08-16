"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/icons";
import { useModalIsolation } from "@/lib/use-modal-isolation";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { GenerationControls } from "@/features/card-generation-v2/GenerationControls";
import type { GenerationControlsDraftV2 } from "@/features/card-generation-v2/contracts/ui-contracts";
import "@/app/styles/card-generation-v2.css";

export interface CardGenerationV2SettingsDialogProps {
  open: boolean;
  noteVersion: number;
  sourceLabel: string;
  initialValue: GenerationControlsDraftV2;
  onClose: () => void;
  onSubmit: (value: GenerationControlsDraftV2) => void;
}

export function CardGenerationV2SettingsDialog({
  open,
  noteVersion,
  sourceLabel,
  initialValue,
  onClose,
  onSubmit,
}: CardGenerationV2SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [value, setValue] = useState<GenerationControlsDraftV2>(initialValue);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const active = open && mounted;
  useModalIsolation(dialogRef, active);
  useFocusTrap(dialogRef, active);
  useBodyScrollLock(active);

  if (!active) return null;

  return createPortal(
    <div
      className="candidate-edit-overlay card-v2-settings-overlay"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="价值优先生成设置"
    >
      <div className="candidate-edit-dialog card-v2-settings-dialog">
        <header>
          <div>
            <p>LEARNING CARD V2</p>
            <h2>价值优先生成设置</h2>
            <span>先决定什么值得学，再生成候选。</span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <Icon.Close />
          </button>
        </header>
        <div className="card-v2-settings-dialog__body">
          <GenerationControls
            value={value}
            noteVersion={noteVersion}
            sourceLabel={sourceLabel}
            onChange={setValue}
            onSubmit={() => onSubmit(value)}
            onCancel={onClose}
            capability="available"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
