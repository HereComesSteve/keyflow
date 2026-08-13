import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { FingeringEditToggle } from './FingeringEditToggle';
import { usePracticeStore } from '../../store';

// 指法编辑模式开关（受控组件：checked/onChange 由 App 持有）。
// 文案按项目约定在 ja/en 两个语言下都使用英文。

describe('FingeringEditToggle', () => {
  beforeEach(() => {
    usePracticeStore.setState({ language: 'ja' });
  });

  it('shows the "Edit fingering" label', () => {
    render(<FingeringEditToggle checked={false} onChange={() => {}} />);
    expect(screen.getByText('Edit fingering')).toBeInTheDocument();
  });

  it('reflects the checked state via aria-pressed and the ON/OFF status text', () => {
    render(<FingeringEditToggle checked={true} onChange={() => {}} />);
    const button = screen.getByTestId('fingering-edit-toggle');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('ON')).toBeInTheDocument();
  });

  it('shows OFF status text when unchecked', () => {
    render(<FingeringEditToggle checked={false} onChange={() => {}} />);
    expect(screen.getByText('OFF')).toBeInTheDocument();
  });

  it('calls onChange with the inverted value when clicked', () => {
    const onChange = vi.fn();
    render(<FingeringEditToggle checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('fingering-edit-toggle'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
