import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { logout } from '@hull/auth/server'

/** Ends the session and sends you to /login. Shared by every Dock-mounted route. */
export function useLogout() {
  const navigate = useNavigate()

  return useCallback(() => {
    void (async () => {
      await logout()
      await navigate({ to: '/login' })
    })()
  }, [navigate])
}
