// Extends app.json with the public name and package id from brand.json, so renaming is one commit.
const brand = require('./brand.json')

function withBrand(config) {
  return {
    ...config,
    name: brand.appName,
    slug: brand.slug,
    scheme: brand.scheme,
    android: { ...config.android, package: brand.androidPackage },
  }
}

module.exports = ({ config }) => withBrand(config)
