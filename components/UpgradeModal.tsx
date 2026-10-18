'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Mic, ChefHat, Camera, Timer, Check, AlertCircle, Loader2 } from 'lucide-react';
import { usePlayBilling, type UsePlayBillingReturn } from '@/lib/hooks/usePlayBilling';
import { TIER_LIMITS } from '@/lib/domain/entitlements';

export interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  reason?: string;
  getToken?: () => Promise<string | null> | string | null;
  onUpgraded?: () => void;
  billing?: Partial<UsePlayBillingReturn>;
}

export function UpgradeModal({
  isOpen,
  onClose,
  reason,
  getToken,
  onUpgraded,
  billing: parentBilling,
}: UpgradeModalProps) {
  // If parent provided billing, avoid spinning up independent remote state
  const fallbackBilling = usePlayBilling({
    getToken: parentBilling ? undefined : getToken,
    autoFetch: false,
  });

  const billing = parentBilling
    ? { ...fallbackBilling, ...parentBilling }
    : fallbackBilling;

  const {
    isPlayBillingAvailable,
    isLoading,
    isPro,
    entitlement,
    refreshEntitlements,
    purchaseSubscription,
    error: billingError,
  } = billing;

  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      if (parentBilling?.refreshEntitlements) {
        void parentBilling.refreshEntitlements();
      } else if (getToken) {
        void fallbackBilling.refreshEntitlements();
      }
    }
  }, [isOpen, getToken, fallbackBilling, parentBilling]);

  const handlePurchase = async () => {
    setLocalError(null);
    const res = await purchaseSubscription();
    if (res.success) {
      setSuccess(true);
      onUpgraded?.();
    } else if (res.error) {
      setLocalError(res.error);
    }
  };

  const displayError = localError || billingError;

  // Calculate usage and percentages
  const voiceLimitSec = TIER_LIMITS.free.voiceSecondsPerCycle; // 900s
  const voiceUsedSec = entitlement?.usage?.voiceSecondsUsed ?? 0;
  const voiceMinsUsed = Math.floor(voiceUsedSec / 60);
  const voicePercent = Math.min(100, Math.round((voiceUsedSec / voiceLimitSec) * 100));

  const recipeLimit = TIER_LIMITS.free.recipeGenerationsPerCycle; // 5
  const recipesUsed = entitlement?.usage?.recipesGeneratedCount ?? 0;
  const recipePercent = Math.min(100, Math.round((recipesUsed / recipeLimit) * 100));

  const scanLimit = TIER_LIMITS.free.visionScansPerCycle; // 3
  const scansUsed = entitlement?.usage?.visionScansCount ?? 0;
  const scanPercent = Math.min(100, Math.round((scansUsed / scanLimit) * 100));

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md max-h-[90dvh] flex flex-col p-6 bg-slate-900 text-slate-100 border border-amber-500/30 overflow-hidden">
        <DialogHeader className="space-y-2 shrink-0">
          <div className="flex items-center justify-between">
            <Badge variant="outline" className="border-amber-400 text-amber-300 bg-amber-950/40 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-amber-400" /> Chef Pro
            </Badge>
            <span className="text-xl font-bold text-amber-400">$4.99<span className="text-xs text-slate-400 font-normal"> / mo</span></span>
          </div>
          <DialogTitle className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            Cook Without Limits
          </DialogTitle>
          <DialogDescription className="text-sm text-slate-300">
            {reason || 'Unlock complete hands-free AI voice cooking, unlimited smart recipe creation, and instant fridge ingredient scanning.'}
          </DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="py-6 text-center space-y-3 overflow-y-auto">
            <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center">
              <Check className="w-6 h-6" />
            </div>
            <h4 className="text-lg font-semibold text-white">Welcome to Chef Pro!</h4>
            <p className="text-sm text-slate-300">Your kitchen is now fully unlocked. All limits have been removed.</p>
            <Button className="w-full mt-4 bg-emerald-600 hover:bg-emerald-500 text-white" onClick={onClose}>
              Start Cooking
            </Button>
          </div>
        ) : isPro ? (
          <div className="py-4 space-y-4 overflow-y-auto">
            <div className="rounded-lg bg-emerald-950/40 border border-emerald-500/30 p-4 text-center space-y-2">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-semibold">
                <Check className="w-4 h-4 text-emerald-400" /> Chef Pro Member Active
              </div>
              <p className="text-sm text-slate-200 font-medium">All kitchen quotas are completely unlimited.</p>
              <p className="text-xs text-slate-400">Enjoy limitless Gemini Live voice cooking, smart recipe creation, and fridge camera scanning.</p>
            </div>
            <Button className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1 -mr-1">
              {/* Live Quota Progress when available */}
              {entitlement && (
                <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3 space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span>Current Free Tier Quotas</span>
                    <span className="text-[10px] text-slate-400 font-normal">Monthly cycle</span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-300 flex items-center gap-1.5">
                        <Mic className="w-3.5 h-3.5 text-amber-400" /> Live Voice
                      </span>
                      <span className="text-slate-400 font-mono text-[11px]">
                        {voiceMinsUsed} / 15 mins
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${voicePercent >= 90 ? 'bg-rose-500' : voicePercent >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${voicePercent}%` }}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-300 flex items-center gap-1.5">
                        <ChefHat className="w-3.5 h-3.5 text-amber-400" /> Recipes Generated
                      </span>
                      <span className="text-slate-400 font-mono text-[11px]">
                        {recipesUsed} / 5
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${recipePercent >= 90 ? 'bg-rose-500' : recipePercent >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${recipePercent}%` }}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-300 flex items-center gap-1.5">
                        <Camera className="w-3.5 h-3.5 text-amber-400" /> Fridge Photo Scans
                      </span>
                      <span className="text-slate-400 font-mono text-[11px]">
                        {scansUsed} / 3
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${scanPercent >= 90 ? 'bg-rose-500' : scanPercent >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${scanPercent}%` }}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2.5">
                <div className="flex items-start gap-3 p-2.5 rounded-lg bg-slate-800/60 border border-slate-700/50">
                  <div className="p-2 rounded-md bg-amber-500/10 text-amber-400 mt-0.5">
                    <Mic className="w-4 h-4" />
                  </div>
                  <div className="text-xs">
                    <div className="font-semibold text-slate-100">Unlimited Gemini Live Voice</div>
                    <div className="text-slate-400">Continuous two-way voice guidance with zero 15-minute monthly cutoff.</div>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-2.5 rounded-lg bg-slate-800/60 border border-slate-700/50">
                  <div className="p-2 rounded-md bg-amber-500/10 text-amber-400 mt-0.5">
                    <ChefHat className="w-4 h-4" />
                  </div>
                  <div className="text-xs">
                    <div className="font-semibold text-slate-100">Unlimited Recipe Generations</div>
                    <div className="text-slate-400">Generate personalized gourmet recipes from whatever you have in stock.</div>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-2.5 rounded-lg bg-slate-800/60 border border-slate-700/50">
                  <div className="p-2 rounded-md bg-amber-500/10 text-amber-400 mt-0.5">
                    <Camera className="w-4 h-4" />
                  </div>
                  <div className="text-xs">
                    <div className="font-semibold text-slate-100">Unlimited Fridge Photo Scans</div>
                    <div className="text-slate-400">Snap a quick photo of your fridge or counter to extract fresh ingredients.</div>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-2.5 rounded-lg bg-slate-800/60 border border-slate-700/50">
                  <div className="p-2 rounded-md bg-amber-500/10 text-amber-400 mt-0.5">
                    <Timer className="w-4 h-4" />
                  </div>
                  <div className="text-xs">
                    <div className="font-semibold text-slate-100">Concurrent Multi-Timer Tracking</div>
                    <div className="text-slate-400">Track multiple cooking timers across pots, pans, and ovens simultaneously.</div>
                  </div>
                </div>
              </div>

              {displayError ? (
                <div className="flex items-center gap-2 p-3 text-xs rounded-md bg-red-950/50 text-red-300 border border-red-800/50">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{displayError}</span>
                </div>
              ) : null}
            </div>

            <DialogFooter className="flex-col sm:flex-col gap-2 pt-3 shrink-0">
              <Button
                className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-slate-950 font-bold shadow-md hover:shadow-amber-500/20 py-2.5"
                onClick={handlePurchase}
                disabled={isLoading || isPro}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Processing...
                  </>
                ) : isPro ? (
                  'You are already Chef Pro'
                ) : (
                  'Subscribe with Google Play'
                )}
              </Button>
              <Button
                variant="ghost"
                className="w-full text-xs text-slate-400 hover:text-slate-200"
                onClick={onClose}
              >
                Maybe later
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
