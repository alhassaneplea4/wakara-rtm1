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
