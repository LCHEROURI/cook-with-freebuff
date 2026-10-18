'use client';

import { useState } from 'react';
import { usePlayBilling } from '@/lib/hooks/usePlayBilling';
import { UpgradeModal } from './UpgradeModal';
import { Sparkles, Mic, Zap } from 'lucide-react';
import { TIER_LIMITS } from '@/lib/domain/entitlements';

export interface HeaderQuotaBadgeProps {
  getToken?: () => Promise<string | null> | string | null;
  className?: string;
}

export function HeaderQuotaBadge({ getToken, className = '' }: HeaderQuotaBadgeProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const billing = usePlayBilling({ getToken, autoFetch: true });

  const { isPro, entitlement } = billing;

  // Derive remaining voice minutes for free tier
  const voiceLimitSec = TIER_LIMITS.free.voiceSecondsPerCycle; // 900s = 15m
  const voiceUsedSec = entitlement?.usage?.voiceSecondsUsed ?? 0;
  const voiceRemainingSec = Math.max(0, voiceLimitSec - voiceUsedSec);
  const voiceRemainingMins = Math.ceil(voiceRemainingSec / 60);

  return (
    <>
      {isPro ? (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gradient-to-r from-amber-500/20 via-amber-400/15 to-amber-500/20 border border-amber-500/40 text-amber-300 hover:border-amber-400 hover:bg-amber-500/30 transition-all shadow-sm cursor-pointer ${className}`}
          aria-label="Chef Pro Member — view subscription details"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
          <span>Chef Pro</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-900/90 hover:bg-slate-800 border border-slate-700/80 hover:border-amber-500/60 text-slate-200 transition-all shadow-sm group cursor-pointer ${className}`}
          aria-label="View monthly cooking quotas and upgrade options"
        >
          <span className="flex items-center gap-1 text-slate-300 group-hover:text-amber-300 transition-colors">
            <Mic className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-mono">{voiceRemainingMins}m voice left</span>
          </span>
          <span className="h-3 w-[1px] bg-slate-700" />
          <span className="text-amber-400 font-semibold flex items-center gap-0.5 group-hover:translate-x-0.5 transition-transform">
            <Zap className="w-3 h-3 text-amber-400 fill-amber-400" /> Upgrade
          </span>
        </button>
      )}

      <UpgradeModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        getToken={getToken}
        onUpgraded={() => {
          void billing.refreshEntitlements();
        }}
      />
    </>
  );
}
