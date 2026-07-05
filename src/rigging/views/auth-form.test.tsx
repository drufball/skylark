// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthForm, type AuthLink } from './auth-form'

afterEach(cleanup)

const FakeLink: AuthLink = ({ to, className, children }) => (
  <a href={to} className={className}>
    {children}
  </a>
)

describe('AuthForm', () => {
  it('login mode has no invite-code field and submits handle + password', () => {
    const onSubmit = vi.fn()
    render(
      <AuthForm
        mode="login"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        Link={FakeLink}
      />,
    )
    expect(screen.queryByLabelText('Invite code')).toBeNull()
    fireEvent.change(screen.getByLabelText('Handle'), {
      target: { value: 'dru' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'hunter22222' },
    })
    fireEvent.click(screen.getByText('Log in'))
    expect(onSubmit).toHaveBeenCalledWith({
      handle: 'dru',
      password: 'hunter22222',
      inviteCode: '',
    })
  })

  it('signup mode has an invite-code field and submits all three', () => {
    const onSubmit = vi.fn()
    render(
      <AuthForm
        mode="signup"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        Link={FakeLink}
      />,
    )
    fireEvent.change(screen.getByLabelText('Handle'), {
      target: { value: 'dru' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'hunter22222' },
    })
    fireEvent.change(screen.getByLabelText('Invite code'), {
      target: { value: 'letmein' },
    })
    fireEvent.click(screen.getByText('Create account'))
    expect(onSubmit).toHaveBeenCalledWith({
      handle: 'dru',
      password: 'hunter22222',
      inviteCode: 'letmein',
    })
  })

  it('shows an error message when given one', () => {
    render(
      <AuthForm
        mode="login"
        busy={false}
        error="Wrong handle or password"
        onSubmit={vi.fn()}
        Link={FakeLink}
      />,
    )
    expect(screen.getByText('Wrong handle or password')).toBeTruthy()
  })

  it('disables submit while busy', () => {
    render(
      <AuthForm
        mode="login"
        busy={true}
        error={null}
        onSubmit={vi.fn()}
        Link={FakeLink}
      />,
    )
    const button = screen.getByText('Log in').closest('button')
    expect(button?.disabled).toBe(true)
  })

  it('cross-links to the other form', () => {
    render(
      <AuthForm
        mode="login"
        busy={false}
        error={null}
        onSubmit={vi.fn()}
        Link={FakeLink}
      />,
    )
    expect(screen.getByText('Sign up').closest('a')?.getAttribute('href')).toBe(
      '/signup',
    )
  })
})
