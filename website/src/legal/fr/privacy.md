---
sourceHash: 28f82b9c0575
title: Memlore — Politique de confidentialité
description: Comment Memlore traite votre journal : il reste sur votre appareil, sans serveur Memlore ni télémétrie, avec un cloud et une IA facultatifs que vous contrôlez.
updated: 4 octobre 2026
---

# Politique de confidentialité

Memlore est un journal intime. Cette page explique ce que l’application et ce site web font des informations — et ce qu’ils ne font jamais.

## Qui nous sommes

Memlore est fait par [Anh-Thi Dinh](https://dinhanhthi.com). C’est une application de journal open source. Questions : [contact@memlore.app](mailto:contact@memlore.app).

## Ce que nous ne collectons pas

Il n’y a ni serveur Memlore ni compte Memlore. L’application ne vous surveille pas.

- Aucune télémétrie
- Aucune statistique d’audience
- Aucune publicité
- Aucun pixel de suivi

## Votre journal sur votre appareil

Votre journal vit sur votre appareil, dans une base de données locale chiffrée. Nous ne pouvons pas le lire.

## Synchronisation cloud facultative

La synchronisation reste désactivée tant que vous ne l’activez pas. Vous choisissez un seul emplacement — votre Google Drive ou votre iCloud Drive. Il n’y a aucun serveur Memlore entre les deux.

Les entrées, les médias et les réglages sont chiffrés sur votre appareil avant d’être envoyés. Une petite liste de synchronisation et un registre des appareils — identifiants, horodatages, marqueurs de suppression et nom de votre appareil, jamais le texte du journal — sont stockés en JSON pour que vos autres appareils sachent quoi récupérer.

## Synchronisation Google Drive facultative

Si vous choisissez Google Drive, vous connectez votre propre compte Google. Memlore ne demande que la portée [drive.appdata](https://www.googleapis.com/auth/drive.appdata). Les fichiers synchronisés se trouvent dans le dossier caché Application Data de Google Drive — invisible sur drive.google.com — et Memlore ne peut pas lire vos autres fichiers Drive.

Le jeton d’actualisation, l’adresse e-mail de votre compte Google et votre quota de stockage Drive restent uniquement dans la base de données chiffrée de cet appareil, afin que l’application puisse afficher le compte connecté. Ils y restent jusqu’à ce que vous vous déconnectiez, puis sont supprimés de la base locale. Le jeton d’accès reste en mémoire, n’est jamais écrit sur le disque et disparaît à la fermeture de l’application.

Se déconnecter dans l’application ne supprime pas les fichiers déjà présents dans votre dossier caché Application Data. Pour supprimer cette copie côté Google, ouvrez Google Drive → Paramètres → Gérer les applications → Memlore → Se déconnecter de Drive.

Les données utilisateur Google servent uniquement à faire fonctionner la synchronisation Drive que vous avez activée. Aucun humain chez Memlore ne lit vos données utilisateur Google. Il n’existe aucun serveur Memlore qu’elles pourraient atteindre. Memlore ne :

- les vend pas, ni ne les transfère à des courtiers en données ou à des revendeurs d’informations
- les utilise pas pour de la publicité, y compris ciblée, personnalisée ou basée sur les centres d’intérêt
- les utilise pas pour développer, améliorer ou entraîner des modèles d’IA ou de ML généralistes ou non personnalisés
- les utilise pas pour évaluer la solvabilité, accorder un prêt ou prendre toute autre décision sans rapport avec les fonctionnalités de l’application
- les transfère pas à des tiers, sauf si cela est nécessaire au fonctionnement de la synchronisation Drive dans votre propre compte Google, ou si la loi l’exige

L’utilisation par Memlore des informations reçues des API Google, et leur transfert vers toute autre application, respecteront la [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), y compris ses exigences de Limited Use.

## iCloud Drive facultatif

Si vous choisissez iCloud Drive (sur un Mac), Memlore écrit dans un dossier Memlore de votre iCloud Drive — le même iCloud Drive que vous voyez déjà dans le Finder.

Memlore ne se connecte pas à Apple à votre place et ne stocke ni mot de passe Apple ni jeton iCloud. Il utilise la session iCloud Drive déjà ouverte sur ce Mac.

Les mêmes données chiffrées et la même liste de synchronisation JSON décrites ci-dessus sont placées dans ce dossier. Apple ne reçoit jamais votre journal en clair. Les conditions iCloud d’Apple s’appliquent.

Vous pouvez vous déconnecter dans l’application. La déconnexion ne supprime pas le dossier Memlore dans iCloud Drive. Supprimez ce dossier vous-même si vous voulez effacer la copie dans le cloud.

## IA facultative

L’IA reste désactivée tant que vous ne l’activez pas et n’acceptez pas un avis de confidentialité. Vous choisissez le fournisseur — local ou sur l’appareil, ou un fournisseur hébergé.

Si vous choisissez un fournisseur hébergé, le texte que vous lui envoyez lui parvient. Memlore n’exploite pas ces services et ne voit pas ce trafic.

## Cartes, lieux et reconnaissance vocale facultatifs

Les cartes, le géocodage et la reconnaissance vocale ne fonctionnent que si vous les activez. Ils communiquent avec le fournisseur que vous choisissez — par exemple Nominatim/OpenStreetMap, Mapbox, MapTiler, Apple MapKit ou votre fournisseur de reconnaissance vocale.

## Mises à jour de l’application

L’application peut demander les métadonnées des versions publiées sur GitHub afin de vous signaler qu’une mise à jour est disponible. Cette vérification n’est pas de la télémétrie.

## Memlore Web (web.memlore.app)

Memlore Web est un compagnon facultatif dans le navigateur qui vous permet de lire votre journal Memlore existant depuis un navigateur web et, une fois l’édition activée, d’y apporter des modifications que votre application de bureau importe.

- **Ce qui est stocké localement dans le navigateur :** Memlore Web ne stocke qu’un cache chiffré dans l’IndexedDB de votre navigateur. Les clés de chiffrement principales sont conservées exclusivement dans la mémoire WebAssembly et effacées dès que vous verrouillez le coffre ou fermez l’onglet. Vos entrées de journal ne sont stockées sur le disque que sous forme de textes chiffrés AES-256-GCM ; le texte non chiffré n’est jamais stocké dans le navigateur.
- **Le Cloudflare Worker :** un Cloudflare Worker éphémère à l’adresse `web.memlore.app/api/*` gère l’échange de jetons OAuth 2.0 PKCE avec Google afin de protéger les secrets client. Le Worker ne voit, n’analyse ni n’enregistre jamais votre phrase de récupération principale, vos clés de chiffrement ou le contenu de votre journal, et ne conserve aucune base de données persistante ni aucun journal d’accès des jetons.
- **Infrastructure d’hébergement :** Memlore Web est hébergé sur Cloudflare Pages. Comme tout serveur web, Cloudflare traite les en-têtes de requête HTTP standard et les adresses IP uniquement pour la protection contre les attaques DDoS et la diffusion du contenu.
- **Portée Google Drive :** Memlore Web se connecte exclusivement à la portée limitée `drive.appdata` de Google Drive (données d’application cachées). Il ne peut ni voir, ni lire, ni modifier vos documents, photos ou feuilles de calcul personnels sur Google Drive.
- **Aucune statistique :** Memlore Web ne contient aucun traceur statistique, script publicitaire, cookie de suivi ni télémétrie comportementale.
- **Comment tout supprimer :** vous pouvez effacer toute trace web à tout moment :
  1. Dans les paramètres de votre navigateur, effacez les données du site web.memlore.app. Cela supprime tout ce que Memlore Web a stocké dans ce navigateur (le cache chiffré, les modifications non envoyées et la clé protégée par mot de passe). Le bouton **Clear cache** des réglages de Memlore Web ne supprime que les photos et vidéos en cache.
  2. Dans l’application de bureau Memlore, ouvrez Settings → Security → Security actions → Connected devices et supprimez l’appareil web.
  3. Révoquez l’accès à Google Drive sur [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Ce site web

Ce site vitrine ne dépose aucun cookie de mesure d’audience et ne collecte aucune donnée de journal. La démo interactive utilise uniquement des données d’exemple.

Le bouton Télécharger est la seule exception, et il mérite d’être précis à son sujet. Il passe par dl.memlore.app, qui compte le téléchargement puis vous redirige vers le fichier sur GitHub. Ce qui est enregistré : l’heure, la version de l’application et le pays que Cloudflare déduit de la connexion. Aucune adresse IP n’est stockée et aucun cookie n’est déposé. Cela se produit lorsque vous téléchargez l’application, jamais pendant que vous l’utilisez — l’application elle-même n’envoie toujours rien, jamais.

## Modifications

Cette politique peut évoluer. La date en haut de la page indique sa dernière mise à jour.

## Nous contacter

Questions de confidentialité : [contact@memlore.app](mailto:contact@memlore.app).

Cette page est une traduction. En cas de divergence, la [version anglaise](/privacy) fait foi.
