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
      purchaseSubscription: vi.fn(),
      devUpgradeToPro: vi.fn().mockResolvedValue({ success: true }),
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

    const button = screen.getByRole('button', { name: /Upgrade to Chef Pro/i });
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
      purchaseSubscription: vi.fn(),
      devUpgradeToPro: vi.fn().mockResolvedValue({ success: false, error: 'Payment network timeout' }),
    });

    render(<UpgradeModal isOpen={true} onClose={vi.fn()} />);

    const button = screen.getByRole('button', { name: /Upgrade to Chef Pro/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('Payment network timeout')).toBeInTheDocument();
    });
  });
});
