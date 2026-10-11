---
sourceHash: da893e9becaf
title: Memlore — Política de privacidad
description: Cómo trata Memlore tu diario: se queda en tu dispositivo, sin servidor de Memlore, sin telemetría, y con nube e IA opcionales que tú controlas.
updated: 10 de octubre de 2026
---

# Política de privacidad

Memlore es un diario privado. Esta página explica qué hacen la app y este sitio web con la información — y qué no hacen nunca.

## Quiénes somos

Memlore está hecho por [Anh-Thi Dinh](https://dinhanhthi.com). Es una app de diario de código abierto. Preguntas: [contact@memlore.app](mailto:contact@memlore.app).

## Lo que no recopilamos

No existe ningún servidor ni ninguna cuenta de Memlore. La app no te vigila.

- Sin telemetría
- Sin analíticas
- Sin publicidad
- Sin píxeles de seguimiento

## Tu diario en tu dispositivo

Tu diario vive en tu dispositivo, en una base de datos local cifrada. No podemos leerlo.

## Sincronización en la nube opcional

La sincronización está desactivada hasta que la activas. Eliges un solo lugar — tu Google Drive o tu iCloud Drive. No hay ningún servidor de Memlore de por medio.

Las entradas, los archivos multimedia y los ajustes se cifran en tu dispositivo antes de subirse. Una pequeña lista de sincronización y un registro de dispositivos — identificadores, marcas de tiempo, indicadores de borrado y el nombre de tu dispositivo, no el texto del diario — se guardan como JSON para que tus otros dispositivos sepan qué descargar.

## Sincronización opcional con Google Drive

Si eliges Google Drive, conectas tu propia cuenta de Google. Memlore solo solicita el ámbito [drive.appdata](https://www.googleapis.com/auth/drive.appdata). Los archivos sincronizados se guardan en la carpeta oculta de datos de aplicaciones de Google Drive — no visible en drive.google.com — y Memlore no puede leer tus demás archivos de Drive.

El token de actualización, el correo de tu cuenta de Google y tu cuota de almacenamiento de Drive se guardan solo en la base de datos cifrada de este dispositivo, para que la app pueda mostrar qué cuenta está conectada. Permanecen ahí hasta que te desconectas, y entonces se eliminan de la base de datos local. El token de acceso se mantiene en memoria, nunca se escribe en disco y desaparece al cerrar la app.

Desconectarte en la app no elimina los archivos que ya están en tu carpeta oculta de datos de aplicaciones. Para borrar esa copia del lado de Google, abre Google Drive → Configuración → Gestionar aplicaciones → Memlore → Desconectar de Drive.

Los datos de usuario de Google se usan únicamente para la sincronización con Drive que has activado. Ninguna persona de Memlore lee tus datos de usuario de Google. No existe ningún servidor de Memlore al que puedan llegar. Memlore no:

- Los vende ni los transfiere a intermediarios de datos o revendedores de información
- Los usa para publicidad, incluidos anuncios dirigidos, personalizados o basados en intereses
- Los usa para desarrollar, mejorar o entrenar modelos de IA o ML generalizados o no personalizados
- Los usa para evaluar la solvencia, conceder préstamos ni para ninguna otra determinación ajena a las funciones de la app
- Los transfiere a terceros, salvo cuando sea necesario para hacer funcionar la sincronización con Drive dentro de tu propia cuenta de Google, o cuando lo exija la ley

El uso que hace Memlore de la información recibida de las API de Google, y su transferencia a cualquier otra app, se ajustará a la [Política de datos de usuario de los servicios de API de Google](https://developers.google.com/terms/api-services-user-data-policy), incluidos los requisitos de uso limitado.

## iCloud Drive opcional

Si eliges iCloud Drive (en un Mac), Memlore escribe en una carpeta Memlore de tu iCloud Drive — el mismo iCloud Drive que ya ves en Finder.

Memlore no inicia sesión en Apple por ti y no guarda ninguna contraseña de Apple ni ningún token de iCloud. Usa la sesión de iCloud Drive ya abierta en este Mac.

En esa carpeta se guardan los mismos datos cifrados y la misma lista de sincronización JSON descritos arriba. Apple no recibe tu diario en claro. Se aplican los términos de iCloud de Apple.

Puedes desconectarte en la app. Desconectarte no elimina la carpeta Memlore de iCloud Drive. Bórrala tú mismo si quieres eliminar la copia en la nube.

## IA opcional

La IA está desactivada hasta que decides activarla y aceptas un aviso de privacidad. Tú eliges el proveedor — local o en el dispositivo, o uno alojado en la nube.

Si eliges un proveedor alojado, el texto que le envías llega a ese proveedor. Memlore no gestiona esos servicios y no ve ese tráfico.

## Mapas, lugares y voz opcionales

Los mapas, la geocodificación y la transcripción de voz solo funcionan si los activas. Se comunican con el proveedor que elijas — por ejemplo Nominatim/OpenStreetMap, Mapbox, MapTiler, Apple MapKit o tu proveedor de transcripción de voz.

## Actualizaciones de la app

La app puede consultar los metadatos de las versiones publicadas en GitHub para avisarte cuando haya una actualización disponible. Esa comprobación no es telemetría.

## Memlore Web (web.memlore.app)

Memlore Web es un complemento opcional para el navegador que te permite leer tu diario Memlore existente desde un navegador web y, una vez activada la edición, hacer cambios que tu app de escritorio importa.

- **Qué se guarda localmente en el navegador:** Memlore Web solo guarda una caché cifrada en el IndexedDB de tu navegador. Las claves maestras de cifrado se mantienen en la memoria de WebAssembly y se borran en cuanto bloqueas la bóveda o cierras la pestaña. Para que recargar la página no vuelva a pedirte la contraseña, la pestaña abierta también guarda una copia sellada de la clave maestra, junto con la clave de un solo uso que la abre, en el almacenamiento de sesión de esa pestaña. La app solo la usa para recargar esa pestaña, hasta que bloqueas o pasa el tiempo de bloqueo automático; al bloquear se borra. El navegador puede conservar en disco el almacenamiento de sesión de una pestaña después de cerrarla (para restaurar pestañas), y el límite de tiempo lo aplica la app, no el cifrado, así que cualquiera que copie el perfil del navegador antes de que bloquees podría abrir el diario. Bloquea la bóveda antes de dejar un ordenador compartido. Tus entradas del diario solo se guardan en disco como textos cifrados con AES-256-GCM; el texto sin cifrar nunca se guarda en el almacenamiento del navegador.
- **El Cloudflare Worker:** Un Cloudflare Worker efímero en `web.memlore.app/api/*` gestiona el intercambio de tokens OAuth 2.0 PKCE con Google para que los secretos de cliente estén protegidos. El Worker nunca ve, analiza ni registra tu frase de recuperación maestra, tus claves de cifrado ni el contenido de tu diario, y no mantiene ninguna base de datos persistente ni registros de acceso de tokens.
- **Infraestructura de alojamiento:** Memlore Web está alojado en Cloudflare Pages. Como cualquier servidor web, Cloudflare procesa las cabeceras HTTP estándar y las direcciones IP exclusivamente para mitigar ataques DDoS y entregar el contenido.
- **Ámbito de Google Drive:** Memlore Web se conecta exclusivamente al ámbito limitado `drive.appdata` de Google Drive (datos de aplicación ocultos). No puede ver, leer ni modificar ninguno de tus documentos, fotos u hojas de cálculo personales de Google Drive.
- **Teselas de mapa (opcional, desactivado por defecto):** La página del mapa en la web primero lista tus lugares sin contactar con ningún proveedor de mapas. Solo después de que actives las teselas de mapa con tu propia clave de API de MapTiler, tu navegador carga teselas de MapTiler, que entonces recibe la zona del mapa que ves y tu dirección IP. Tu clave de API se guarda cifrada en este navegador. Puedes dejar de usar las teselas de mapa en cualquier momento.
- **Sin analíticas:** Memlore Web no contiene rastreadores de analíticas, scripts publicitarios, cookies de seguimiento ni telemetría de comportamiento.
- **Cómo borrarlo todo:** Puedes eliminar todo rastro web en cualquier momento:
  1. En la configuración de tu navegador, borra los datos del sitio web.memlore.app. Así se elimina todo lo que Memlore Web guardó en ese navegador (la caché cifrada, los cambios sin enviar y la clave protegida por contraseña). El botón **Clear cache** de los ajustes de Memlore Web solo elimina las fotos y los vídeos almacenados en caché.
  2. En la app de escritorio Memlore, abre Settings → Security → Security actions → Connected devices y elimina el dispositivo web.
  3. Revoca el acceso a Google Drive en [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Este sitio web

Este sitio web promocional no instala cookies de analíticas y no recopila datos del diario. La demo interactiva solo usa datos de ejemplo.

El botón Descargar es la única excepción, y conviene ser precisos al respecto. Pasa por dl.memlore.app, que cuenta la descarga y luego te lleva al archivo en GitHub. Lo que se registra es la hora, la versión de la app y el país que Cloudflare deduce de la conexión. No se guarda ninguna dirección IP ni se instala ninguna cookie. Ocurre cuando descargas la app, nunca mientras la usas — la app en sí sigue sin enviar nada, nunca.

## Cambios

Esta política puede cambiar. La fecha que aparece en la parte superior de la página indica cuándo se actualizó por última vez.

## Cómo contactarnos

Preguntas sobre privacidad: [contact@memlore.app](mailto:contact@memlore.app).

Esta página es una traducción. En caso de discrepancia, prevalece la [versión en inglés](/privacy).
