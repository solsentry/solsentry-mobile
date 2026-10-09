import { API_BASE } from '../config'
import { API_BASE_OVERRIDE, SELFTEST_BUILD } from './build-flags'

export { SELFTEST_BUILD }

export const KYW_API_BASE: string = API_BASE_OVERRIDE ?? API_BASE
