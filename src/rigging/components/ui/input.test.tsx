// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { Input, inputClass, selectClass } from './input'

describe('Input', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders an input element', () => {
    const { container } = render(<Input data-testid="test-input" />)
    const input = container.querySelector('input')
    expect(input).toBeTruthy()
  })

  it('forwards props to native input', () => {
    const { container } = render(<Input type="email" placeholder="Email" />)
    const input = container.querySelector('input')
    expect(input?.getAttribute('type')).toBe('email')
    expect(input?.getAttribute('placeholder')).toBe('Email')
  })

  it('merges custom className with defaults', () => {
    const { container } = render(<Input className="custom-class" />)
    const input = container.querySelector('input')
    expect(input?.className).toContain('custom-class')
    expect(input?.className).toContain('rounded-md')
  })

  it('applies disabled attribute when disabled', () => {
    const { container } = render(<Input disabled />)
    const input = container.querySelector('input')
    expect(input?.hasAttribute('disabled')).toBe(true)
  })
})

describe('inputClass', () => {
  it('returns the base input class string', () => {
    const classes = inputClass()
    expect(classes).toContain('rounded-md')
    expect(classes).toContain('border')
    expect(classes).toContain('focus-visible:ring')
  })

  it('includes additional classes when provided', () => {
    const classes = inputClass('extra-class')
    expect(classes).toContain('extra-class')
    expect(classes).toContain('rounded-md')
  })
})

describe('selectClass', () => {
  it('returns the base select class string', () => {
    const classes = selectClass()
    expect(classes).toContain('rounded-md')
    expect(classes).toContain('border')
    expect(classes).toContain('focus-visible:ring')
  })

  it('includes additional classes when provided', () => {
    const classes = selectClass('extra-class')
    expect(classes).toContain('extra-class')
    expect(classes).toContain('rounded-md')
  })
})
