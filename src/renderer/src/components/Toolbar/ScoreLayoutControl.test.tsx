import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ScoreLayoutControl } from './ScoreLayoutControl';
import { usePracticeStore } from '../../store';

describe('ScoreLayoutControl labels and behavior', () => {
  beforeEach(() => {
    usePracticeStore.setState({ scoreLayout: 'vertical' });
  });

  it('shows both layout options and reflects the current store value', () => {
    render(<ScoreLayoutControl />);
    expect(screen.getByTestId('score-layout-toggle')).toBeInTheDocument();
    const vertical = screen.getByTestId('score-layout-vertical') as HTMLButtonElement;
    const horizontal = screen.getByTestId('score-layout-horizontal') as HTMLButtonElement;
    expect(vertical.textContent).toBe('Vertical');
    expect(horizontal.textContent).toBe('Horizontal');
  });

  it('switches the store scoreLayout when a button is clicked', () => {
    render(<ScoreLayoutControl />);
    fireEvent.click(screen.getByTestId('score-layout-horizontal'));
    expect(usePracticeStore.getState().scoreLayout).toBe('horizontal');
    fireEvent.click(screen.getByTestId('score-layout-vertical'));
    expect(usePracticeStore.getState().scoreLayout).toBe('vertical');
  });
});
