// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HeaderQuotaBadge } from './HeaderQuotaBadge';

describe('HeaderQuotaBadge', () => {
  it('renders free quota indicator and upgrade trigger on free tier', () => {
    const handleClick = vi.fn();
    render(
      <HeaderQuotaBadge
        isPro={false}
        entitlement={{
          userId: 'user-1',
          tier: 'free',
          status: 'active',
          updatedAtMs: Date.now(),
          usage: {
            cycleStartMs: Date.now(),
            voiceSecondsUsed: 180, // 3 mins used -> 12 mins left
            recipesGeneratedCount: 1,
            visionScansCount: 0,
          },
        }}
        onClick={handleClick}
      />,
    );

    expect(screen.getByText('12m voice left')).toBeInTheDocument();
    expect(screen.getByText('Upgrade')).toBeInTheDocument();

    const button = screen.getByRole('button', { name: /View monthly cooking quotas and upgrade options/i });
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('renders Chef Pro badge when user is pro member', () => {
    const handleClick = vi.fn();
    render(
      <HeaderQuotaBadge
        isPro={true}
        entitlement={null}
        onOpenUpgrade={handleClick}
      />,
    );

    expect(screen.getByText('Chef Pro')).toBeInTheDocument();
    expect(screen.queryByText(/voice left/i)).not.toBeInTheDocument();

    const button = screen.getByRole('button', { name: /Chef Pro Member — view subscription details/i });
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('renders neutral Quotas & Pro trigger when entitlement is not yet loaded', () => {
    const handleClick = vi.fn();
    render(
      <HeaderQuotaBadge
        isPro={false}
        entitlement={null}
        onClick={handleClick}
      />,
    );

    expect(screen.getByText('Quotas & Pro')).toBeInTheDocument();
    expect(screen.queryByText(/voice left/i)).not.toBeInTheDocument();

    const button = screen.getByRole('button', { name: /View monthly cooking quotas and upgrade options/i });
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
