import brand from '../../brand.config.json'
import { validateBrandConfig } from './brand-config'

validateBrandConfig(brand)

export const PRODUCT_NAME = brand.productName
export const DEVELOPMENT_PRODUCT_NAME = brand.developmentProductName
export const USER_DATA_DIRECTORY = brand.userDataDirectory
export const DEVELOPMENT_USER_DATA_DIRECTORY = brand.developmentUserDataDirectory
export const UPDATE_BASE_URL: string | null = brand.updateBaseUrl
export const DESKTOP_SERVICE_URL: string | null = brand.desktopServiceUrl
export const SUPPORT_URL: string | null = brand.supportUrl
export const WINDOWS_PUBLISHER_NAME: string | null = brand.publisherName
export const UPDATE_UNAVAILABLE_MESSAGE = 'HQHarness update service is not configured.'
export const UPDATE_IDENTITY_UNAVAILABLE_MESSAGE = 'HQHarness update signing identity is missing or does not match the configured channel.'
