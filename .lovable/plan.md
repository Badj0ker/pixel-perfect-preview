# Fázis 2 — Élő vétel/eladás volumen

Rövid válasz: nem nagy munka. Ugyanaz a lánc-adat forrás, amit a radar már használ — a Pump.fun program minden vételt és eladást is eseményként küld, csak eddig nem olvastuk ki őket.

## Mit fog látni a felhasználó

- Minden tokennél élő számok: vétel darabszám, eladás darabszám, összesített SOL forgalom.
- Vétel/eladás arány sávként (zöld/piros), hogy egy pillantásra látszódjon a nyomás iránya.
- Utolsó 1 perc / 5 perc forgalom, hogy az elhaló tokenek elváljanak a felfutóktól.
- Rendezés forgalom szerint, nem csak kor szerint.
- Kereskedések élő listája a kiválasztott tokennél: idő, irány, SOL összeg, pénztárca.

## Hogyan épül fel

1. Új tábla a kereskedéseknek: token, irány (vétel/eladás), SOL mennyiség, token mennyiség, pénztárca, tranzakció aláírás, időbélyeg. Nyilvános olvasás, írás csak a szerver oldalról.
2. Összesítő mezők a meglévő token táblán (vétel/eladás darab, teljes SOL forgalom, utolsó kereskedés ideje), hogy a lista gyorsan betöltsön.
3. A meglévő figyelő kiegészítése: a Pump.fun tranzakciók naplóiból a kereskedési események kiolvasása (a létrehozási események mellett), majd mentés és az összesítők frissítése.
4. A radar felület kiegészítése az új oszlopokkal, a nyomásjelző sávval és a token-részletek panellel.

## Technikai részletek

- A `TradeEvent` ugyanabban a `Program data:` naplósorban érkezik, mint a már feldolgozott `CreateEvent` — a különbség az anchor diszkriminátor. Mezők: mint, solAmount, tokenAmount, isBuy, user, timestamp, virtuális készletek. A meglévő base58 + DataView dekóder újrahasznosítható.
- A lekérdezés `getSignaturesForAddress` + `getTransaction` marad, de nagyobb limittel, mert kereskedésből sokkal több van, mint létrehozásból. A lekérdezett tranzakciókat egyszer dolgozzuk fel mindkét eseménytípusra.
- A virtuális SOL/token készletből azonnal számolható az aktuális ár és a piaci kapitalizáció — ezt is elmentjük, gyakorlatilag ingyen.
- Az összesítőket adatbázis triggerrel vagy a beszúrás utáni frissítéssel tartjuk naprakészen.
- A `pump_trades` tábla gyorsan nő: 24 óránál régebbi sorokra takarítás.

## Korlát

Poll-alapú lekérdezéssel néhány másodperc csúszás marad, és sűrű forgalomnál nem minden kereskedés kerül be. Ha teljes lefedettség kell, a következő lépés a WebSocket alapú `logsSubscribe` figyelő — azt külön fázisként érdemes megcsinálni.
