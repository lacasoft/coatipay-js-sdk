# Política de seguridad

Este SDK maneja **claves secretas y firmas de pago**. Si encuentras una
vulnerabilidad, queremos saberlo antes que nadie.

## Cómo reportar

**📧 security@coatipay.com**

Escríbenos en español o inglés, como te resulte natural. Incluye lo que tengas:
qué falla, cómo reproducirlo, y qué impacto le ves. Un reporte parcial es mejor
que ningún reporte.

- Acusamos recibo en **48 horas**.
- **Reconocimiento público** cuando el fix esté desplegado, y sitio en el [hall
  of fame](https://github.com/lacasoft/coatipay-protocol/blob/master/SECURITY.md#hall-of-fame) del protocolo.
- **Recompensa en USDC** por hallazgos críticos, discrecional y acordada caso
  por caso, **cuando el treasury tenga flujo sostenido**. Somos early-stage y
  hoy no lo tiene: preferimos decírtelo antes de que inviertas tu tiempo, no
  después. Un programa formal con tabla de pagos llegará junto con la auditoría
  externa.
- Te damos crédito público cuando el fix esté publicado, salvo que prefieras
  permanecer anónimo.

## Divulgación responsable

Por favor **no publiques la vulnerabilidad** en redes ni foros hasta que esté
corregida y publicada. Mientras el fallo siga vivo, difundirlo pone en riesgo
las integraciones de terceros.

## Especialmente relevante aquí

- **Fuga de la clave secreta.** La `sk_` va **solo en el backend**. Si detectas
  un camino por el que este SDK la exponga al navegador o a los logs, es crítico.
- **Verificación de webhooks.** `webhooks.verify()` valida el formato, la
  frescura del timestamp (anti-replay) y compara el HMAC en tiempo constante.
  Cualquier forma de saltarse eso es crítica.
- **Construcción de la firma EIP-712.** Un error que haga firmar al pagador algo
  distinto de lo que aprueba es crítico.

## Alcance

**Dentro:** el código de `src/` de este repositorio.

**Fuera:** los contratos (en
[`coatipay-protocol`](https://github.com/lacasoft/coatipay-protocol)) y la
infraestructura que opera CoatiPay. Si el fallo está ahí, escríbenos igual a la
misma dirección y lo encaminamos.
