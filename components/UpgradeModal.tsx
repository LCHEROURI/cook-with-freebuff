'use client';

import { useState } from 'react';
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
import { usePlayBilling } from '@/lib/hooks/usePlayBilling';

export interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  reason?: string;
  getToken?: () => Promise<string | null> | string | null;
  onUpgraded?: () => void;
}

export function UpgradeModal({
  isOpen,
  onClose,
  reason,
  getToken,
  onUpgraded,
}: UpgradeModalProps) {
  const {
    isPlayBillingAvailable,
    isLoading,
    isPro,
    purchaseSubscription,
    error: billingError,
  } = usePlayBilling({ getToken, autoFetch: false });

  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);

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

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md p-6 bg-slate-900 text-slate-100 border border-amber-500/30">
        <DialogHeader className="space-y-2">
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
          <div className="py-6 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center">
              <Check className="w-6 h-6" />
            </div>
            <h4 className="text-lg font-semibold text-white">Welcome to Chef Pro!</h4>
            <p className="text-sm text-slate-300">Your kitchen is now fully unlocked. All limits have been removed.</p>
            <Button className="w-full mt-4 bg-emerald-600 hover:bg-emerald-500 text-white" onClick={onClose}>
              Start Cooking
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
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

            <DialogFooter className="flex-col sm:flex-col gap-2 pt-2">
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
                ) : isPlayBillingAvailable ? (
                  'Subscribe with Google Play'
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
