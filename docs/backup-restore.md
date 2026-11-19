# Sauvegarde et restauration

Deux éléments à sauvegarder **ensemble** : la base de données et les pièces justificatives (`PRIVATE_MEDIA_ROOT`).
Les secrets (`.env`) se sauvegardent séparément, dans un coffre, jamais avec les données.

## Commandes fournies

```bash
python manage.py backup_wakara --output-dir /var/backups/wakara --keep 30
```

Produit `wakara_AAAAMMJJ_HHMMSS.zip` contenant :

- la base (SQLite : copie cohérente à chaud ; PostgreSQL : `pg_dump -F c`, mot de passe via `PGPASSWORD`),
- le dossier `private_media/`.

Les archives au-delà de `--keep` sont supprimées (les plus anciennes uniquement).

### Planification (cron, exemple : chaque nuit à 02:00)

```
0 2 * * * cd /opt/wakara/backend && venv/bin/python manage.py backup_wakara --output-dir /var/backups/wakara >> /var/log/wakara/backup.log 2>&1
```

Copier ensuite les archives **hors du serveur** (autre site / stockage chiffré).

## Restauration

1. **Arrêter** l'application.
2. ```bash
   python manage.py restore_wakara /var/backups/wakara/wakara_20261029_020000.zip --yes
   ```
   - SQLite : le fichier courant est déplacé en `*.before-restore-<date>` (jamais supprimé) puis remplacé.
   - PostgreSQL : le dump est extrait dans `backend/restore_<date>.dump` et la commande `pg_restore` à exécuter est affichée
     (elle exige les droits d'administration de la base).
   - Les pièces justificatives sont restaurées ; le dossier existant est mis de côté (`*.before-restore-<date>`).
3. `python manage.py check`, redémarrer, puis vérifier : connexion, un dossier récent, le téléchargement d'une pièce.

## Test de restauration

Une sauvegarde non testée n'est pas une sauvegarde. Le test automatisé `tests/test_backup.py` vérifie l'aller-retour
sauvegarde → corruption → restauration sur SQLite. **À faire en recette** : restaurer une archive réelle PostgreSQL sur
un serveur de test et consigner la date et le résultat dans le registre d'exploitation.

## Sauvegarde automatique quotidienne (GitHub Actions)

Le fichier `.github/workflows/sauvegarde-base.yml` fait chaque jour à 02:00 UTC un `pg_dump` complet de la base, **chiffré en AES-256**
avant d'être gardé 14 jours comme artefact privé du dépôt. Il reste **inactif** tant que deux secrets ne sont pas créés
(*Settings → Secrets and variables → Actions*) :

| Secret | Contenu |
|---|---|
| `BACKUP_DATABASE_URL` | Adresse PostgreSQL d'un rôle **en lecture seule** (à créer dans Neon pour cet usage), avec `?sslmode=require` |
| `BACKUP_PASSPHRASE` | Phrase de passe longue (30 caractères ou plus), **à conserver aussi dans un gestionnaire de mots de passe de la mairie** : sans elle, une sauvegarde est illisible |

Lancer une première fois à la main (*Actions → Sauvegarde automatique de la base → Run workflow*) et **vérifier** qu'un artefact `sauvegarde-base` apparaît.

**Restaurer** (sur une base de test d'abord) :

```bash
gpg --batch --decrypt --passphrase-fd 3 wakara-AAAA-MM-JJ.dump.gpg 3<<<"$BACKUP_PASSPHRASE" > wakara.dump
pg_restore --no-owner --clean --if-exists -d "$URL_BASE_DE_TEST" wakara.dump
```

**Décision à prendre par la mairie.** Le dump contient des données personnelles d'état civil (et les photos des fiches : elles sont dans la base).
Le confier à GitHub (États-Unis) est un choix à valider comme l'hébergement lui-même. Alternatives : la restauration à un instant donné
(*point-in-time*) et les branches de Neon (selon l'offre, durée de rétention limitée sur l'offre gratuite) ; ou `python manage.py backup_wakara` lancé
depuis une machine de la mairie et copié sur un support chiffré hors site. Dans tous les cas : **une sauvegarde n'existe que si une restauration a été essayée**.
