import { defineConfig } from 'vitest/config'

/**
 * Twenty seconds per case instead of the five-second default.
 *
 * This suite boots real plugin trees and negotiates real RTC connections, so single cases legitimately take
 * seconds; on a loaded developer machine (DSH Desktop, the isolated web instance and a proxy all running) the
 * default tipped over and reported timeouts for tests that pass in isolation. A genuine hang still fails - just
 * later - and nothing here waits on a remote service.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
})
