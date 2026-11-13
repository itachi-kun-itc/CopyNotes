# Phone number detection

`libphonenumber-max.js` is the unmodified browser bundle from the official npm
package `libphonenumber-js@1.13.15` (`package/bundle/libphonenumber-max.js`).

Upstream: https://github.com/catamphetamine/libphonenumber-js

The full metadata validates phone number formats. Detection uses Japan as the
default country; explicit international country codes are supported. Detection
runs in the browser and does not send note contents to an external service.

The MIT and Apache 2.0 license texts are included alongside the bundle.

Package integrity:
`sha512-AHdhEQeDFEJ4GKDAQ9AwxChy+v2kUILUB3TGQRpkXMkWePjXTU/WQEzWVQoIx/Gz8fE73Wr5SEuZCy2vk8jrMQ==`

To update, download the pinned official npm package with `npm pack --ignore-scripts`,
replace the browser bundle and both license files, then run the link tests and
both environment builds.
