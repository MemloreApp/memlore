---
sourceHash: 28f82b9c0575
title: Memlore — Datenschutzerklärung
description: Wie Memlore mit deinem Tagebuch umgeht: Es bleibt auf deinem Gerät, ohne Memlore-Server, ohne Telemetrie, mit optionaler Cloud und KI unter deiner Kontrolle.
updated: 4. Oktober 2026
---

# Datenschutzerklärung

Memlore ist ein privates Tagebuch. Diese Seite erklärt, was die App und diese Website mit Informationen tun — und was sie niemals tun.

## Wer wir sind

Memlore wird von [Anh-Thi Dinh](https://dinhanhthi.com) entwickelt. Es ist eine Open-Source-Tagebuch-App. Fragen: [contact@memlore.app](mailto:contact@memlore.app).

## Was wir nicht erheben

Es gibt keinen Memlore-Server und kein Memlore-Konto. Die App beobachtet dich nicht.

- Keine Telemetrie
- Keine Analyse
- Keine Werbung
- Keine Tracking-Pixel

## Dein Tagebuch auf deinem Gerät

Dein Tagebuch liegt auf deinem Gerät, in einer verschlüsselten lokalen Datenbank. Wir können es nicht lesen.

## Optionaler Cloud-Sync

Sync bleibt aus, bis du ihn einschaltest. Du wählst einen Ort — dein Google Drive oder dein iCloud Drive. Es gibt keinen Memlore-Server dazwischen.

Einträge, Medien und Einstellungen werden auf deinem Gerät verschlüsselt, bevor sie hochgeladen werden. Eine kleine Sync-Liste und ein Geräteverzeichnis — IDs, Zeitstempel, Löschmarkierungen und dein Gerätename, kein Tagebuchtext — werden als JSON gespeichert, damit deine anderen Geräte wissen, was sie abrufen sollen.

## Optionaler Google-Drive-Sync

Wenn du Google Drive wählst, verbindest du dein eigenes Google-Konto. Memlore fordert nur den Bereich [drive.appdata](https://www.googleapis.com/auth/drive.appdata) an. Synchronisierte Dateien liegen im versteckten Ordner "Application Data" von Google Drive — auf drive.google.com nicht sichtbar — und Memlore kann deine anderen Drive-Dateien nicht lesen.

Das Refresh-Token, die E-Mail-Adresse deines Google-Kontos und dein Drive-Speicherkontingent bleiben ausschließlich in der verschlüsselten Datenbank auf diesem Gerät, damit die App anzeigen kann, welches Konto verbunden ist. Sie bleiben dort, bis du die Verbindung trennst, und werden dann aus der lokalen Datenbank gelöscht. Das Access-Token bleibt im Arbeitsspeicher, wird nie auf die Festplatte geschrieben und ist weg, sobald die App geschlossen wird.

Das Trennen der Verbindung in der App löscht nicht die Dateien, die bereits in deinem versteckten Ordner "Application Data" liegen. Um diese Kopie bei Google zu entfernen, öffne Google Drive → Einstellungen → Apps verwalten → Memlore → Verbindung mit Drive trennen.

Google-Nutzerdaten werden ausschließlich für den Drive-Sync verwendet, den du eingeschaltet hast. Kein Mensch bei Memlore liest deine Google-Nutzerdaten. Es gibt keinen Memlore-Server, den sie erreichen könnten. Memlore wird sie nicht:

- verkaufen oder an Datenhändler oder Informationswiederverkäufer weitergeben
- für Werbung verwenden, einschließlich gezielter, personalisierter oder interessenbasierter Werbung
- verwenden, um allgemeine oder nicht personalisierte KI- oder ML-Modelle zu entwickeln, zu verbessern oder zu trainieren
- für Bonitätsprüfungen, Kreditvergaben oder andere Entscheidungen verwenden, die nichts mit den Funktionen der App zu tun haben
- an Dritte weitergeben, außer soweit nötig, um den Drive-Sync in deinem eigenen Google-Konto zu betreiben, oder wenn das Gesetz es verlangt

Die Nutzung und Weitergabe von Informationen, die Memlore über Google-APIs erhält, an andere Apps erfolgt gemäß der [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), einschließlich der Anforderungen zur eingeschränkten Nutzung (Limited Use).

## Optionales iCloud Drive

Wenn du iCloud Drive wählst (auf einem Mac), schreibt Memlore in einen Memlore-Ordner in deinem iCloud Drive — dasselbe iCloud Drive, das du bereits im Finder siehst.

Memlore meldet dich nicht bei Apple an und speichert weder ein Apple-Passwort noch ein iCloud-Token. Es nutzt die iCloud-Drive-Sitzung, die auf diesem Mac bereits besteht.

Dieselben verschlüsselten Daten und dieselbe JSON-Sync-Liste wie oben beschrieben landen in diesem Ordner. Apple erhält dein Tagebuch nicht im Klartext. Es gelten die iCloud-Bedingungen von Apple.

Du kannst die Verbindung in der App trennen. Das Trennen löscht den Memlore-Ordner in iCloud Drive nicht. Entferne diesen Ordner selbst, wenn die Kopie in der Cloud verschwinden soll.

## Optionale KI

KI bleibt aus, bis du zustimmst und einen Datenschutzhinweis akzeptierst. Du wählst den Anbieter — lokal oder auf dem Gerät, oder einen gehosteten.

Wenn du einen gehosteten Anbieter wählst, geht der Text, den du ihm sendest, an diesen Anbieter. Memlore betreibt diese Dienste nicht und sieht diesen Datenverkehr nicht.

## Optionale Karten, Orte und Spracherkennung

Karten, Geocoding und Spracherkennung laufen nur, wenn du sie einschaltest. Sie kommunizieren mit dem Anbieter deiner Wahl — zum Beispiel Nominatim/OpenStreetMap, Mapbox, MapTiler, Apple MapKit oder deinem Anbieter für Spracherkennung.

## App-Updates

Die App kann Release-Metadaten von GitHub abrufen, um dir mitzuteilen, wenn ein Update verfügbar ist. Diese Prüfung ist keine Telemetrie.

## Memlore Web (web.memlore.app)

Memlore Web ist eine optionale Browser-Ergänzung, mit der du dein bestehendes Memlore-Tagebuch in einem Webbrowser lesen und, sobald Bearbeiten eingeschaltet ist, Änderungen vornehmen kannst, die deine Desktop-App importiert.

- **Was lokal im Browser gespeichert wird:** Memlore Web speichert nur einen verschlüsselten Cache in der IndexedDB deines Browsers. Die Master-Verschlüsselungsschlüssel werden ausschließlich im WebAssembly-Speicher gehalten und gelöscht, sobald du den Tresor sperrst oder den Tab schließt. Deine Tagebucheinträge werden auf dem Datenträger nur als AES-256-GCM-verschlüsselte Chiffretexte gespeichert; unverschlüsselter Text wird nie im Browserspeicher abgelegt.
- **Der Cloudflare Worker:** Ein flüchtiger Cloudflare Worker unter `web.memlore.app/api/*` übernimmt den OAuth-2.0-PKCE-Tokenaustausch mit Google, damit Client-Secrets geschützt bleiben. Der Worker sieht, verarbeitet oder protokolliert niemals deine Master-Wiederherstellungsphrase, Verschlüsselungsschlüssel oder Tagebuchinhalte und führt weder eine dauerhafte Datenbank noch Zugriffsprotokolle über Tokens.
- **Hosting-Infrastruktur:** Memlore Web wird auf Cloudflare Pages gehostet. Wie jeder Webserver verarbeitet Cloudflare übliche HTTP-Request-Header und IP-Adressen ausschließlich zur DDoS-Abwehr und Auslieferung von Inhalten.
- **Google-Drive-Bereich:** Memlore Web verbindet sich ausschließlich mit dem eingeschränkten Bereich `drive.appdata` von Google Drive (versteckte Anwendungsdaten). Es kann keine deiner persönlichen Google-Drive-Dokumente, Fotos oder Tabellen ansehen, lesen oder ändern.
- **Keine Analyse:** Memlore Web enthält keine Analyse-Tracker, Werbeskripte, Tracking-Cookies oder Verhaltenstelemetrie.
- **So löschst du alles:** Du kannst alle Web-Spuren jederzeit entfernen:
  1. Lösche in den Einstellungen deines Browsers die Websitedaten für web.memlore.app. Damit wird alles gelöscht, was Memlore Web in diesem Browser gespeichert hat (der verschlüsselte Cache, nicht gesendete Änderungen und der passwortgeschützte Schlüssel). Die Schaltfläche **Clear cache** in den Einstellungen von Memlore Web entfernt nur zwischengespeicherte Fotos und Videos.
  2. Öffne in der Memlore-Desktop-App Settings → Security → Security actions → Connected devices und entferne das Web-Gerät.
  3. Widerrufe den Google-Drive-Zugriff unter [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Diese Website

Diese Website setzt keine Analyse-Cookies und erhebt keine Tagebuchdaten. Die interaktive Demo verwendet ausschließlich Beispieldaten.

Der Download-Button ist die einzige Ausnahme, und hier lohnt es sich, genau zu sein. Er führt über dl.memlore.app, das den Download zählt und dich dann zur Datei auf GitHub weiterleitet. Erfasst werden der Zeitpunkt, die App-Version und das Land, das Cloudflare aus der Verbindung ableitet. Es wird keine IP-Adresse gespeichert und kein Cookie gesetzt. Das geschieht, wenn du die App herunterlädst, nie während du sie nutzt — die App selbst sendet weiterhin nichts, niemals.

## Änderungen

Diese Erklärung kann sich ändern. Das Datum oben auf der Seite zeigt, wann sie zuletzt aktualisiert wurde.

## So erreichst du uns

Fragen zum Datenschutz: [contact@memlore.app](mailto:contact@memlore.app).

Diese Seite ist eine Übersetzung. Im Zweifelsfall ist die [englische Fassung](/privacy) maßgeblich.
