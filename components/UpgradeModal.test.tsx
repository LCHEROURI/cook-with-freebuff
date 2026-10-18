// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { UpgradeModal } from './UpgradeModal';

const mockUsePlayBilling = vi.fn();

vi.mock('@/lib/hooks/usePlayBilling', () => ({
  usePlayBilling: (opts: unknown) => mockUsePlayBilling(opts),
}));

describe('UpgradeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePlayBilling.mockReturnValue({
      isPlayBillingAvailable: false,
      isLoading: false,
      isPro: false,
      tier: 'free',
      entitlement: null,
      error: null,
      purchaseSubscription: vi.fn().mockResolvedValue({ success: true }),
    });
  });

  it('renders modal with benefits and pricing when open', () => {
    render(<UpgradeModal isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Cook Without Limits')).toBeInTheDocument();
    expect(screen.getByText('Unlimited Gemini Live Voice')).toBeInTheDocument();
    expect(screen.getByText('Unlimited Recipe Generations')).toBeInTheDocument();
    expect(screen.getByText('Unlimited Fridge Photo Scans')).toBeInTheDocument();
    expect(screen.getByText('$4.99')).toBeInTheDocument();
  });

  it('displays custom reason when provided', () => {
    const customReason = 'Voice limit reached. Upgrade to continue hands-free cooking.';
    render(<UpgradeModal isOpen={true} onClose={vi.fn()} reason={customReason} />);

    expect(screen.getByText(customReason)).toBeInTheDocument();
  });

  it('handles upgrade flow and shows success state', async () => {
    const onUpgraded = vi.fn();
    render(<UpgradeModal isOpen={true} onClose={vi.fn()} onUpgraded={onUpgraded} />);

    const button = screen.getByRole('button', { name: /Subscribe with Google Play/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('Welcome to Chef Pro!')).toBeInTheDocument();
    });
    expect(onUpgraded).toHaveBeenCalled();
  });

  it('shows error message when upgrade fails', async () => {
    mockUsePlayBilling.mockReturnValue({
      isPlayBillingAvailable: false,
      isLoading: false,
      isPro: false,
      tier: 'free',
      entitlement: null,
      error: null,
      purchaseSubscription: vi.fn().mockResolvedValue({ success: false, error: 'Payment network timeout' }),
    });

    render(<UpgradeModal isOpen={true} onClose={vi.fn()} />);

    const button = screen.getByRole('button', { name: /Subscribe with Google Play/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('Payment network timeout')).toBeInTheDocument();
    });
  });

  it('renders live quota progress bars when free entitlement is provided', () => {
    mockUsePlayBilling.mockReturnValue({
      isPlayBillingAvailable: true,
      isLoading: false,
      isPro: false,
      tier: 'free',
      entitlement: {
        usage: {
          voiceSecondsUsed: 300, // 5 mins used
          recipesGeneratedCount: 3,
          visionScansCount: 2,
        },
      },
      error: null,
      refreshEntitlements: vi.fn(),
      purchaseSubscription: vi.fn(),
    });

    render(<UpgradeModal isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Current Free Tier Quotas')).toBeInTheDocument();
    expect(screen.getByText('5 / 15 mins')).toBeInTheDocument();
    expect(screen.getByText('3 / 5')).toBeInTheDocument();
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
  });

  it('renders active member view when isPro is true', () => {
    mockUsePlayBilling.mockReturnValue({
      isPlayBillingAvailable: true,
      isLoading: false,
      isPro: true,
      tier: 'pro',
      entitlement: null,
      error: null,
      refreshEntitlements: vi.fn(),
      purchaseSubscription: vi.fn(),
    });

    render(<UpgradeModal isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText('Chef Pro Member Active')).toBeInTheDocument();
    expect(screen.getByText('All kitchen quotas are completely unlimited.')).toBeInTheDocument();
  });

  it('uses parent billing prop when provided instead of fetching independently', () => {
    const parentRefresh = vi.fn();
    const parentBilling = {
      isPro: true,
      isLoading: false,
      isPlayBillingAvailable: true,
      entitlement: null,
      refreshEntitlements: parentRefresh,
    };

    render(<UpgradeModal isOpen={true} onClose={vi.fn()} billing={parentBilling} />);

    expect(screen.getByText('Chef Pro Member Active')).toBeInTheDocument();
    expect(parentRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not re-invoke refreshEntitlements on subsequent re-renders while modal remains open', () => {
    const parentRefresh = vi.fn();
    const parentBilling = {
      isPro: false,
      isLoading: false,
      isPlayBillingAvailable: true,
      entitlement: null,
      refreshEntitlements: parentRefresh,
    };

    const { rerender } = render(<UpgradeModal isOpen={true} onClose={vi.fn()} billing={{ ...parentBilling }} />);
    expect(parentRefresh).toHaveBeenCalledTimes(1);

    // Re-render with new billing object reference (simulating parent state updates)
    rerender(<UpgradeModal isOpen={true} onClose={vi.fn()} billing={{ ...parentBilling }} />);
    expect(parentRefresh).toHaveBeenCalledTimes(1);
  });
});
