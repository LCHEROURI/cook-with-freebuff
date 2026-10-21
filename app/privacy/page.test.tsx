// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PrivacyPolicyPage from './page';

describe('PrivacyPolicyPage', () => {
  it('renders privacy policy heading and contact info', () => {
    render(<PrivacyPolicyPage />);

    expect(screen.getByRole('heading', { name: /privacy policy/i, level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText(/com\.freebuff\.cookwithme/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/cherouri@gmail\.com/i).length).toBeGreaterThan(0);
  });

  it('renders link back to home', () => {
    render(<PrivacyPolicyPage />);

    const homeLinks = screen.getAllByRole('link', { name: /home|cook with me/i });
    expect(homeLinks.length).toBeGreaterThan(0);
    expect(homeLinks.some((link) => link.getAttribute('href') === '/')).toBe(true);
  });
});
