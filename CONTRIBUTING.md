# Contribuir

Gracias por querer aportar. Escribe en **español o inglés**, lo que te resulte
natural — ambos idiomas son bienvenidos en issues y pull requests.

## Poner en marcha

```bash
npm install
npm run build
npm test
```

Este SDK depende de [`@lacasoft/coatipay-protocol`](https://github.com/lacasoft/coatipay-protocol)
(tipos y constantes), que se instala desde npm como cualquier otra dependencia.

Si necesitas trabajar contra un protocolo **sin publicar** —por ejemplo, para
probar un tipo nuevo antes de su release— enlázalo en local:

```bash
cd ../coatipay-protocol/protocol && npm link
cd ../../coatipay-js-sdk        && npm link @lacasoft/coatipay-protocol
```

Deshaz el enlace con `npm unlink @lacasoft/coatipay-protocol` antes de abrir el
PR: la dependencia publicada debe quedar como está en `package.json`.

## Antes de abrir el PR

```bash
npm run typecheck
npm run build
npm test
```

Si arreglas un fallo, añade el test que lo reproduce. Si cambias la API pública,
dilo en la descripción del PR: hay integraciones en producción que dependen de
ella.

## Seguridad

¿Encontraste una vulnerabilidad? **No abras un issue.** Escribe a
**security@coatipay.com** — ver [SECURITY.md](SECURITY.md).
