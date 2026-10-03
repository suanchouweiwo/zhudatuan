export const serviceTargets = Object.freeze({
  'internal-runtime': ['InternalRuntimeMain', 'InternalRuntimeReadyMain', 'LocalKmsMain', 'LocalSecretsMain', 'LocalObjectsMain', 'CatalogObjectStoreReadyMain', 'BootstrapOwner', 'BootstrapRegistration'],
  'identity-api': ['IdentityRegistrationApiMain', 'IdentityRegistrationApiReadyMain'],
  'identity-notification-jobs': ['IdentityNotificationJobsOnlyMain', 'IdentityNotificationJobsReadyMain'],
  'mall-provisioning-api': ['MallProvisioningApiMain', 'MallProvisioningApiReadyMain'],
  'support-api': ['ConsoleSupportMain'],
  'purchase-api': ['PurchaseApiMain', 'PurchaseApiReadyMain'],
  'web-api': ['WebBusinessApiMain', 'WebBusinessApiReadyMain'],
  'catalog-api': ['CatalogOperatorApiMain', 'CatalogOperatorApiReadyMain'],
  'catalog-jobs': ['CatalogJobsMain', 'CatalogJobsReadyMain'],
  'payment-webhook-api': ['PaymentWebhookApiMain', 'PaymentWebhookApiReadyMain'],
  'payment-jobs': ['PaymentJobsOnlyMain', 'PaymentJobsReadyMain'],
});

export const serviceEntryDirectory = '01_core_hexin/services/commerce/src/entry';

export const serviceEntryOverrides = Object.freeze({
  LocalKmsMain: '04_tools/tools/localkms/src/Main.ts',
  LocalSecretsMain: '04_tools/tools/localsecrets/src/Main.ts',
  InternalRuntimeMain: '04_tools/tools/localinfra/src/Run.ts',
  InternalRuntimeReadyMain: '04_tools/tools/localinfra/src/RegistrationReady.ts',
  LocalObjectsMain: '04_tools/tools/localobjects/src/Main.ts',
  BootstrapOwner: '04_tools/tools/seed/src/BootstrapOwner.ts',
  BootstrapRegistration: '04_tools/tools/seed/src/BootstrapRegistration.ts',
});
