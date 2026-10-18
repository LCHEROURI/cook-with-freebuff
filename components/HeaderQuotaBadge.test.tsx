// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HeaderQuotaBadge } from './HeaderQuotaBadge';

const mockUsePlayBilling = vi.fn();

vi.mock('@/lib/hooks/usePlayBilling', () => ({
  usePlayBilling: (opts: unknown) => mockUsePlayBilling(opts),
}));

describe('HeaderQuotaBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders free quota indicator and upgrade trigger on free tier', () => {
    mockUsePlayBilling.mockReturnValue({
      isPlayBillingAvailable: true,
      isLoading: false,
      isPro: false,
      tier: 'free',
      entitlement: {
        usage: {
          voiceSecondsUsed: 180, // 3 mins used -> 12 mins left
          recipesGeneratedCount: 1,
          visionScansCount: 0,
        },
      },
      error: null,
      refreshEntitlements: vi.fn(),
      purchaseSubscription: vi.fn(),
    });

    render(<HeaderQuotaBadge getToken={vi.fn()} />);

    expect(screen.getByText('12m voice left')).toBeInTheDocument();
    expect(screen.getByText('Upgrade')).toBeInTheDocument();
  });

  it('renders Chef Pro badge when user is pro member', () => {
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

    render(<HeaderQuotaBadge getToken={vi.fn()} />);

    expect(screen.getByText('Chef Pro')).toBeInTheDocument();
    expect(screen.queryByText(/voice left/i)).not.toBeInTheDocument();
  });

  it('opens upgrade modal when clicked', () => {
    mockUsePlayBilling.mockReturnValue({
      isPlayBillingAvailable: true,
      isLoading: false,
      isPro: false,
      tier: 'free',
      entitlement: null,
      error: null,
      refreshEntitlements: vi.fn(),
      purchaseSubscription: vi.fn(),
    });

    render(<HeaderQuotaBadge getToken={vi.fn()} />);

    const badgeButton = screen.getByRole('button', { name: /View monthly cooking quotas and upgrade options/i });
    fireEvent.click(badgeButton);

    expect(screen.getByText('Cook Without Limits')).toBeInTheDocument();
  });
});
