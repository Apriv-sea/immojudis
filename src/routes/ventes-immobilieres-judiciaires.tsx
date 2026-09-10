"use client";

import { createFileRoute, Link } from "@/lib/router-compat";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import { SaleTypesOverview } from "@/components/SaleTypesOverview";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";

const RESOURCES_CANONICAL = "https://immojudis-dezt.vercel.app/ventes-immobilieres-judiciaires";
const RESOURCES_TITLE =
  "Ressources ventes immobilières judiciaires : annonces, risques et prix plafond | Immojudis";
const DESCRIPTION =
  "Immojudis référence et analyse les ventes immobilières judiciaires : annonces, cahier des conditions de vente, risques, frais, occupation, prix plafond et enchères au tribunal.";

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Immojudis référence-t-il uniquement des ventes au tribunal ?",
    a: "Non. Immojudis réunit les ventes au tribunal et les enchères notariales référencées, ainsi que les ventes domaniales selon les sources disponibles. Le catalogue n’est pas exhaustif. Le type, le cadre juridique et le mode de participation sont distingués sur chaque dossier.",
  },
  {
    q: "Une vente en ligne est-elle un type de vente à part ?",
    a: "Non. En ligne décrit la façon de participer, pas le cadre juridique. Il faut toujours identifier l’organisateur et lire les conditions de la vente.",
  },
  {
    q: "Qui peut acheter un bien aux enchères au tribunal ?",
    a: "Toute personne juridiquement capable peut acheter un bien aux enchères au tribunal, sous réserve de respecter les formalités, de disposer des garanties financières nécessaires et d'être représentée par un avocat.",
  },
  {
    q: "Un avocat est-il toujours obligatoire ?",
    a: "Pour une vente judiciaire à la barre du tribunal, oui : un avocat est obligatoire. Pour une vente notariale ou domaniale, consultez les conditions du dossier. Au tribunal, les enchères doivent être portées par un avocat inscrit au barreau compétent.",
  },
  {
    q: "Peut-on obtenir un prêt bancaire ?",
    a: "Oui, mais le financement doit être préparé avant l'audience. L'adjudication n'est pas conditionnée à l'obtention d'un prêt comme dans une vente classique. L'acheteur doit donc être certain de sa capacité à payer le prix et les frais.",
  },
  {
    q: "Le bien peut-il être occupé ?",
    a: "Oui. Le bien peut être libre, loué, occupé par l'ancien propriétaire ou par un tiers. L'occupation doit être analysée avant l'audience, car elle peut modifier fortement la valeur et le calendrier du projet.",
  },
  {
    q: "Où consulter le cahier des conditions de vente ?",
    a: "Il peut être consulté au greffe du tribunal judiciaire ou auprès de l'avocat poursuivant. Immojudis aide à identifier les informations clés à extraire de ce document.",
  },
  {
    q: "Une mise à prix basse signifie-t-elle une bonne affaire ?",
    a: "Non. La mise à prix est seulement le point de départ des enchères. La qualité de l'opération dépend du prix final, des frais, des travaux, de l'occupation, du marché local et des risques juridiques ou techniques.",
  },
  {
    q: "Peut-on se rétracter après avoir gagné l'enchère ?",
    a: "Non. Une enchère portée engage l'acheteur. En cas de défaut de paiement, l'adjudicataire s'expose à des conséquences financières importantes.",
  },
  {
    q: "Que se passe-t-il en cas de surenchère ?",
    a: "Si une surenchère régulière est formée dans le délai légal, une nouvelle audience est organisée. L'adjudication initiale n'est alors pas définitive.",
  },
  {
    q: "Immojudis remplace-t-il un avocat ?",
    a: "Non. Immojudis est un outil de référencement, de lecture et d'aide à la décision. Il ne remplace pas l'accompagnement d'un avocat, seul habilité à porter les enchères et à vous conseiller juridiquement dans la procédure.",
  },
];

const TOC: Array<{ href: string; label: string }> = [
  { href: "#differences", label: "Tribunal, notaire ou État : quelle différence ?" },
  { href: "#definition", label: "Qu'est-ce qu'une vente immobilière judiciaire ?" },
  { href: "#origine", label: "Pourquoi un bien est-il vendu aux enchères ?" },
  { href: "#immojudis", label: "Immojudis : décider avant d'enchérir" },
  { href: "#recherche", label: "Comment trouver une vente judiciaire ?" },
  { href: "#deroulement", label: "Comment se déroule une vente judiciaire ?" },
  { href: "#frais", label: "Quels frais prévoir ?" },
  { href: "#avantages", label: "Quels sont les avantages ?" },
  { href: "#risques", label: "Quels sont les risques ?" },
  { href: "#methode", label: "La méthode Immojudis" },
  { href: "#lexique", label: "Lexique" },
  { href: "#liens-institutionnels", label: "Liens institutionnels utiles" },
  { href: "#faq", label: "Questions fréquentes" },
];

const METHOD: Array<{ n: string; title: string; text: string }> = [
  {
    n: "1",
    title: "Identifier le bien",
    text: "Localisation, type de bien, surface, étage, dépendances, copropriété, environnement, accès, destination et potentiel d'usage.",
  },
  {
    n: "2",
    title: "Lire les pièces",
    text: "Annonce, cahier des conditions de vente, procès-verbal descriptif, diagnostics, documents de copropriété, informations d'urbanisme, occupation, servitudes et mentions particulières.",
  },
  {
    n: "3",
    title: "Repérer les risques",
    text: "Occupation, travaux, humidité, copropriété, charges, contentieux, servitudes, accès, état locatif, financement, liquidité à la revente.",
  },
  {
    n: "4",
    title: "Comparer au marché",
    text: "Analyse des ventes comparables, niveau de prix local, tension locative, potentiel de revente, décote à appliquer, marge de sécurité.",
  },
  {
    n: "5",
    title: "Calculer le coût complet",
    text: "Prix d'adjudication estimé, frais, droits, honoraires, travaux, charges, délais, financement, fiscalité et imprévus.",
  },
  {
    n: "6",
    title: "Fixer un prix plafond",
    text: "Le prix plafond est la limite à ne pas dépasser. Il doit être défini avant l'audience et respecté strictement.",
  },
];

const LEXIQUE: Array<{ term: string; def: string }> = [
  {
    term: "Adjudication",
    def: "Attribution du bien au meilleur enchérisseur à l'issue de l'audience.",
  },
  {
    term: "Adjudicataire",
    def: "Personne qui remporte la vente et devient acquéreur du bien, sous réserve des suites de la procédure.",
  },
  {
    term: "Avocat poursuivant",
    def: "Avocat qui conduit la procédure pour le compte du créancier ou de la partie à l'origine de la vente.",
  },
  {
    term: "Cahier des conditions de vente",
    def: "Document juridique décrivant le bien, les règles de la vente, les conditions d'occupation, les diagnostics, les servitudes et les frais.",
  },
  {
    term: "Consignation",
    def: "Garantie financière exigée pour participer à l'enchère ou sécuriser la procédure.",
  },
  {
    term: "Mise à prix",
    def: "Prix de départ de la vente aux enchères. Elle ne doit pas être confondue avec la valeur réelle du bien.",
  },
  {
    term: "Prix plafond",
    def: "Montant maximum à ne pas dépasser, calculé à partir du marché, des frais, des travaux, des risques et de la stratégie de l'acheteur.",
  },
  {
    term: "Saisie immobilière",
    def: "Procédure permettant à un créancier de faire vendre un bien immobilier afin d'obtenir le paiement d'une dette.",
  },
  {
    term: "Surenchère",
    def: "Offre formée après une adjudication, dans les conditions et délais prévus par la loi, entraînant une nouvelle audience.",
  },
  {
    term: "Vente à la barre",
    def: "Expression couramment utilisée pour désigner une vente aux enchères judiciaires devant le tribunal.",
  },
];

const INSTITUTIONAL_LINKS: Array<{ href: string; label: string }> = [
  {
    href: "https://www.service-public.gouv.fr/particuliers/vosdroits/F16987",
    label: "Service-Public.fr — Saisie immobilière",
  },
  {
    href: "https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000025024948/LEGISCTA000025939111/",
    label: "Légifrance — Code des procédures civiles d'exécution, vente par adjudication",
  },
  {
    href: "https://www.legifrance.gouv.fr/codes/id/LEGISCTA000025939177",
    label: "Légifrance — Surenchère",
  },
  {
    href: "https://www.justice.fr/",
    label: "Justice.fr — Portail officiel du ministère de la Justice",
  },
  { href: "https://www.cnb.avocat.fr/", label: "Conseil national des barreaux" },
  {
    href: "https://commissaire-justice.fr/",
    label: "Chambre nationale des commissaires de justice",
  },
  {
    href: "https://consignations.caissedesdepots.fr/professionnel-du-droit/difficultes-financieres/saisie-immobiliere",
    label: "Caisse des Dépôts — Saisie immobilière et consignations",
  },
  {
    href: "https://www.notaires.fr/fr/immobilier-fiscalite/vente-rapide/les-ventes-aux-encheres-immobilieres-notariales",
    label: "Notaires de France — Ventes aux enchères immobilières notariales",
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

export const Route = createFileRoute("/ventes-immobilieres-judiciaires")({
  head: () => ({
    meta: [
      { title: RESOURCES_TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "index, follow" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: RESOURCES_TITLE },
      {
        property: "og:description",
        content:
          "Trouvez, analysez et préparez vos ventes immobilières judiciaires avec Immojudis : annonces, risques, frais, occupation et prix plafond.",
      },
      { property: "og:url", content: RESOURCES_CANONICAL },
    ],
    links: [{ rel: "canonical", href: RESOURCES_CANONICAL }],
  }),
  component: ResourcesPage,
});

export function ResourcesPage() {
  return (
    <main className="liquid-page min-h-screen bg-background pb-24 text-foreground">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />

      <article className="mx-auto max-w-5xl px-4 pt-10 sm:px-6">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <header className="glass-shell rounded-lg p-6 sm:p-9">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            Immojudis · Ressources ventes judiciaires
          </p>
          <h1 className="mt-4 max-w-3xl font-display text-4xl leading-[1.08] text-foreground sm:text-5xl md:text-6xl">
            Ventes immobilières judiciaires : trouvez, analysez et décidez avant d'enchérir
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Acheter un bien lors d'une vente immobilière judiciaire peut être une opportunité. Mais
            ce n'est jamais un achat immobilier classique. Avant d'enchérir, il faut comprendre la
            procédure, lire les pièces, évaluer les risques, intégrer les frais et fixer une limite
            à ne pas dépasser.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <IntroCard title="Annonces centralisées">
              Repérez les ventes judiciaires à venir par localisation, tribunal, type de bien, date
              d'audience et mise à prix.
            </IntroCard>
            <IntroCard title="Analyse du dossier">
              Identifiez les éléments clés : occupation, cahier des conditions de vente,
              diagnostics, frais, travaux et contraintes.
            </IntroCard>
            <IntroCard title="Prix plafond">
              Décidez avec méthode grâce à une approche en coût complet, intégrant les frais, les
              risques et la valeur de marché.
            </IntroCard>
          </div>
        </header>

        {/* ── Sommaire ─────────────────────────────────────────────────── */}
        <nav aria-labelledby="sommaire" className="liquid-panel mt-6 rounded-lg p-5 sm:p-6">
          <h2 id="sommaire" className="font-display text-xl text-foreground">
            Sommaire
          </h2>
          <ul className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {TOC.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-gold-soft hover:underline"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* ── Corps ────────────────────────────────────────────────────── */}
        <div className="mt-10 space-y-2">
          <Section id="differences" title="Tribunal, notaire ou État : quelle différence ?">
            <P>
              Immojudis ne se limite pas aux ventes au tribunal. Le catalogue rassemble les ventes
              judiciaires et les enchères notariales référencées ; les ventes domaniales disposent
              aussi de leur catégorie, selon les annonces disponibles.
            </P>
            <SaleTypesOverview detailed />
            <div className="mt-5 rounded-md border border-brand-navy/15 bg-white p-5">
              <h3 className="font-semibold text-brand-navy">
                Trois informations à ne pas confondre
              </h3>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-brand-navy/80">
                <li>
                  <strong>L’organisateur :</strong> tribunal, office notarial ou organisme de
                  l’État.
                </li>
                <li>
                  <strong>Le cadre juridique :</strong> saisie, partage judiciaire, liquidation ou
                  vente volontaire, selon le dossier.
                </li>
                <li>
                  <strong>La participation :</strong> sur place, en ligne ou les deux. « En ligne »
                  n’est pas un type de vente.
                </li>
              </ul>
            </div>
            <P>
              Toutes les enchères ne sont donc pas judiciaires. Inversement, une vente organisée par
              un notaire peut avoir une origine judiciaire. Les règles de représentation, de
              garantie, de financement et de paiement doivent être vérifiées dans les conditions
              propres à la vente.
            </P>
            <P>
              Sources officielles :{" "}
              <Ext href="https://www.justice.fr/fiche/saisie-immobiliere">
                Justice.fr — saisie immobilière
              </Ext>
              ,{" "}
              <Ext href="https://www.immobilier.notaires.fr/fr/articles/conseils-et-actualites/achat-vente/les-ventes-aux-encheres-notariales">
                Notaires de France — enchères notariales
              </Ext>{" "}
              et{" "}
              <Ext href="https://www.economie.gouv.fr/particuliers/mes-droits-conso/bien-consommer/ventes-aux-encheres-publiques-vous-pouvez-y-participer">
                Ministère de l’Économie — ventes publiques
              </Ext>
              .
            </P>
            <P>La suite de ce guide détaille les ventes judiciaires à la barre du tribunal.</P>
          </Section>

          <Section id="definition" title="Qu'est-ce qu'une vente immobilière judiciaire ?">
            <P>
              Une vente immobilière judiciaire est une vente aux enchères d'un bien immobilier
              organisée dans un cadre judiciaire. Ce guide traite des ventes à la barre du tribunal,
              sous le contrôle du juge ; certaines ventes d’origine judiciaire sont organisées par
              un notaire.
            </P>
            <P>
              Le bien est attribué au plus offrant. Cette attribution s'appelle l'adjudication.
              L'acheteur qui remporte l'enchère devient l'adjudicataire, sous réserve notamment de
              l'absence de surenchère dans le délai légal.
            </P>
            <P>
              Les ventes judiciaires peuvent concerner de nombreux types de biens : appartement,
              maison, immeuble, local commercial, terrain, cave, parking, garage, lot de copropriété
              ou actif immobilier issu d'une procédure collective.
            </P>
            <P>
              Contrairement à une vente classique, l'acheteur ne signe pas un compromis avec un
              vendeur. Il participe à une procédure encadrée, avec des règles strictes, des délais
              courts et des conséquences importantes en cas de mauvaise préparation.
            </P>
            <P>
              Pour consulter le cadre général de la saisie immobilière, vous pouvez vous référer à
              la page officielle de Service-Public :{" "}
              <Ext href="https://www.service-public.gouv.fr/particuliers/vosdroits/F16987">
                Saisie immobilière – Service-Public.fr
              </Ext>
              .
            </P>
          </Section>

          <Section id="origine" title="Pourquoi un bien est-il vendu aux enchères judiciaires ?">
            <P>
              Un bien immobilier peut être vendu judiciairement dans plusieurs situations. La plus
              connue est la saisie immobilière. Lorsqu'un débiteur ne paie pas sa dette, un
              créancier peut engager une procédure visant à faire vendre le bien afin de récupérer
              tout ou partie des sommes dues.
            </P>
            <P>
              Une vente judiciaire peut aussi intervenir dans le cadre d'une liquidation judiciaire,
              d'un partage judiciaire entre indivisaires, d'une succession conflictuelle, d'un
              divorce ou d'une décision de justice ordonnant la vente d'un immeuble.
            </P>
            <P>
              Dans tous les cas, l'acheteur doit comprendre que la vente est liée à une procédure.
              Cela explique la présence du tribunal, des avocats, du greffe, du commissaire de
              justice et de documents juridiques spécifiques.
            </P>
          </Section>

          <Section id="immojudis" title="Immojudis : décider avant d'enchérir">
            <P>
              Immojudis est conçu pour les acheteurs qui veulent aller plus loin qu'une simple
              annonce. Une annonce de vente judiciaire donne des informations de base : adresse du
              bien, mise à prix, date d'audience, tribunal compétent, avocat poursuivant, modalités
              de visite. Mais elle ne suffit pas pour décider.
            </P>
            <P>
              Ce qui compte réellement, c'est l'analyse du dossier. Immojudis aide à structurer
              cette analyse autour de plusieurs questions essentielles.
            </P>
            <Checklist
              items={[
                "Le bien est-il libre ou occupé ?",
                "Le cahier des conditions de vente mentionne-t-il des servitudes, contraintes, charges ou particularités ?",
                "Les diagnostics révèlent-ils des risques techniques ?",
                "Le procès-verbal descriptif permet-il d'identifier des travaux importants ?",
                "La mise à prix est-elle réellement attractive par rapport au marché local ?",
                "Quel budget total faut-il prévoir après frais, travaux et marge de sécurité ?",
                "Quel est le prix plafond à ne pas dépasser pour que l'opération reste rationnelle ?",
              ]}
            />
            <Callout>
              L'enjeu est simple : ne pas enchérir parce que la mise à prix semble basse, mais parce
              que le dossier a été lu, compris et chiffré.
            </Callout>
          </Section>

          <Section id="recherche" title="Comment trouver une vente immobilière judiciaire ?">
            <P>
              Les ventes immobilières judiciaires font l'objet de publicités obligatoires. Elles
              peuvent être publiées dans des journaux d'annonces légales, affichées au tribunal,
              relayées par des avocats, par certains sites spécialisés ou par des plateformes de
              référencement.
            </P>
            <P>
              En pratique, l'information est souvent fragmentée. Une vente peut être connue
              localement, mais difficile à repérer pour un acheteur qui surveille plusieurs
              départements ou plusieurs tribunaux.
            </P>
            <P>
              Immojudis centralise les annonces et facilite la recherche par critères :
              localisation, tribunal, date d'audience, type de bien, mise à prix, surface,
              occupation, niveau de risque ou potentiel d'investissement.
            </P>
            <P>
              L'objectif est de permettre une veille efficace sur les ventes judiciaires à venir,
              sans perdre de temps à consulter manuellement des sources dispersées.
            </P>
          </Section>

          <Section id="deroulement" title="Comment se déroule une vente immobilière judiciaire ?">
            <P>
              La vente immobilière judiciaire se déroule en trois temps : l'analyse avant la vente,
              l'audience d'adjudication, puis les formalités après l'enchère.
            </P>

            <SubTitle>1. Avant la vente : analyser le dossier</SubTitle>
            <P>
              La phase préparatoire est la plus importante. C'est avant l'audience que se gagne ou
              se perd une bonne opération.
            </P>

            <SubTitle>Lire l'annonce de vente</SubTitle>
            <P>
              L'annonce permet d'identifier rapidement le bien et les principales informations
              pratiques : adresse, désignation sommaire, mise à prix, date et heure d'audience,
              tribunal, avocat poursuivant, visites, références du dossier.
            </P>
            <P>
              La mise à prix doit être interprétée avec prudence. Elle correspond au prix de départ
              des enchères, pas à la valeur de marché du bien. Une mise à prix faible peut attirer
              de nombreux enchérisseurs. Elle peut aussi traduire des contraintes : occupation,
              travaux lourds, procédure complexe, faible liquidité ou incertitude juridique.
            </P>

            <SubTitle>Consulter le cahier des conditions de vente</SubTitle>
            <P>
              Le cahier des conditions de vente est le document central d'une vente judiciaire. Il
              décrit le bien, les conditions de la vente, l'origine de propriété, les éventuelles
              servitudes, les inscriptions, les diagnostics, la situation d'occupation, les
              informations d'urbanisme, les frais et les règles applicables à l'adjudication.
            </P>
            <P>
              Il peut être consulté au greffe du tribunal judiciaire ou auprès de l'avocat
              poursuivant. Dans certains dossiers, des extraits ou documents associés peuvent être
              accessibles en ligne.
            </P>
            <P>
              Immojudis accorde une importance particulière à ce document, car il contient souvent
              les informations qui changent complètement la lecture d'une opportunité : bail en
              cours, occupation incertaine, procédure d'expulsion à prévoir, servitude, copropriété
              en difficulté, état du bien, contraintes de jouissance ou charges particulières.
            </P>
            <P>
              Pour consulter les textes applicables à la vente par adjudication, vous pouvez vous
              référer à Légifrance :{" "}
              <Ext href="https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000025024948/LEGISCTA000025939111/">
                Code des procédures civiles d'exécution – Vente par adjudication
              </Ext>
              .
            </P>

            <SubTitle>Étudier l'occupation du bien</SubTitle>
            <P>
              L'occupation est l'un des points les plus sensibles. Un bien peut être libre, loué,
              occupé par son propriétaire, occupé par un tiers, ou faire l'objet d'une situation peu
              claire.
            </P>
            <P>
              L'impact est majeur : délai de prise de possession, possibilité de louer, coût d'une
              procédure, décote à appliquer, stratégie de revente ou de travaux. Un appartement
              occupé avec un bail opposable ne se valorise pas comme un appartement libre.
            </P>
            <P>
              Avant toute enchère, il faut donc vérifier précisément la situation d'occupation dans
              les pièces du dossier, et ne pas se contenter d'une simple mention dans l'annonce.
            </P>

            <SubTitle>Visiter le bien</SubTitle>
            <P>
              Les visites sont généralement organisées avant l'audience, sur un ou plusieurs
              créneaux. Elles sont souvent collectives et encadrées par un commissaire de justice.
            </P>
            <P>
              Il est fortement recommandé d'y assister. Les photos et descriptifs ne suffisent pas.
              Lors de la visite, il faut observer l'état général, les travaux visibles, les
              installations, les traces d'humidité, la luminosité, les accès, les parties communes,
              le voisinage immédiat et les contraintes pratiques.
            </P>
            <P>
              Pour les biens à rénover, il peut être utile de se faire accompagner par un
              professionnel du bâtiment. Une estimation trop optimiste des travaux peut transformer
              une enchère intéressante en mauvaise opération.
            </P>
            <P>
              Pour mieux comprendre le rôle des commissaires de justice, vous pouvez consulter le
              site institutionnel de la profession :{" "}
              <Ext href="https://commissaire-justice.fr/">
                Chambre nationale des commissaires de justice
              </Ext>
              .
            </P>

            <SubTitle>Évaluer le marché local</SubTitle>
            <P>
              Une vente judiciaire doit être comparée au marché réel. La bonne question n'est pas :
              « la mise à prix est-elle basse ? » mais : « à quel prix total ce bien reste-t-il
              intéressant, compte tenu des frais, travaux et risques ? »
            </P>
            <P>
              Immojudis raisonne en coût complet. Le prix d'adjudication n'est qu'un élément du
              calcul. Il faut ajouter les frais préalables, droits de mutation, émoluments,
              honoraires d'avocat, frais de publication, travaux, charges, financement et marge de
              sécurité.
            </P>
            <P>Cette approche permet de fixer un prix plafond rationnel avant l'audience.</P>

            <SubTitle>Préparer le financement</SubTitle>
            <P>
              L'achat aux enchères judiciaires ne fonctionne pas comme une vente classique avec
              condition suspensive d'obtention de prêt. Si vous remportez l'enchère, vous êtes
              engagé.
            </P>
            <P>
              Il est donc nécessaire de sécuriser son financement avant l'audience : accord bancaire
              solide, apport disponible, capacité à payer les frais et délai de déblocage compatible
              avec les exigences de la procédure.
            </P>
            <P>
              Un refus de prêt après adjudication ne permet pas de se désengager simplement. Le
              défaut de paiement peut entraîner des conséquences financières importantes.
            </P>

            <SubTitle>Être représenté par un avocat</SubTitle>
            <P>
              Pour enchérir lors d'une vente immobilière judiciaire, l'acheteur doit être représenté
              par un avocat inscrit au barreau du tribunal compétent. L'acheteur ne porte pas
              lui-même les enchères.
            </P>
            <P>
              Avant l'audience, l'avocat prépare le pouvoir d'enchérir, vérifie les garanties
              financières, porte les enchères à la barre et accompagne l'adjudicataire dans les
              formalités après la vente.
            </P>
            <P>
              Pour trouver un avocat ou vérifier les informations institutionnelles relatives à la
              profession, vous pouvez consulter le site du Conseil national des barreaux :{" "}
              <Ext href="https://www.cnb.avocat.fr/">Conseil national des barreaux</Ext>.
            </P>

            <SubTitle>Prévoir les garanties et frais avant l'audience</SubTitle>
            <P>
              Avant de pouvoir enchérir, il faut remettre à son avocat les garanties financières
              nécessaires. En pratique, l'enchérisseur doit notamment prévoir un chèque de banque ou
              une caution bancaire selon les conditions de la vente, ainsi qu'un montant destiné à
              couvrir les frais.
            </P>
            <P>
              Ces sommes doivent être préparées avant l'audience. Sans dossier complet, l'avocat ne
              pourra pas porter les enchères.
            </P>
            <P>
              Le détail des frais doit être demandé à l'avocat. Il est indispensable de les intégrer
              dans le prix plafond.
            </P>

            <SubTitle>2. Le jour de l'audience : enchérir au tribunal</SubTitle>
            <P>
              L'audience d'adjudication se tient au tribunal judiciaire. Elle est publique, mais les
              enchères sont portées par les avocats.
            </P>
            <P>
              Le juge rappelle la vente, la mise à prix et les éléments essentiels du dossier. Les
              avocats portent ensuite les enchères pour leurs clients. Chaque enchère engage
              l'enchérisseur.
            </P>
            <P>
              Lorsque plus aucune enchère supérieure n'est portée dans le délai prévu, le dernier
              enchérisseur est déclaré adjudicataire.
            </P>
            <P>
              Pour un premier achat, il peut être utile d'assister à une audience sans enchérir.
              Cela permet de comprendre le rythme, la procédure, le rôle des avocats et l'ambiance
              de la salle de vente.
            </P>

            <SubTitle>3. Après l'adjudication : surenchère, paiement et propriété</SubTitle>
            <P>
              Remporter l'audience ne signifie pas toujours que l'achat est immédiatement définitif.
            </P>
            <P>
              Après l'adjudication, une surenchère peut être formée dans le délai légal. Elle doit
              respecter les conditions prévues par les textes, notamment être déposée par acte
              d'avocat au greffe compétent.
            </P>
            <P>
              Vous pouvez consulter le texte officiel sur Légifrance :{" "}
              <Ext href="https://www.legifrance.gouv.fr/codes/id/LEGISCTA000025939177">
                Code des procédures civiles d'exécution – Surenchère
              </Ext>
              .
            </P>
            <P>
              Si aucune surenchère n'est formée, l'adjudication devient définitive. L'adjudicataire
              doit alors payer le prix et les frais dans les délais prévus.
            </P>
            <P>
              Dans le cadre d'une vente forcée, le prix peut être consigné par l'avocat de
              l'adjudicataire auprès de la Caisse des Dépôts. Pour plus d'informations, consultez la
              page officielle :{" "}
              <Ext href="https://consignations.caissedesdepots.fr/professionnel-du-droit/difficultes-financieres/saisie-immobiliere">
                Caisse des Dépôts – Saisie immobilière et consignations
              </Ext>
              .
            </P>
            <P>
              Après paiement et formalités de publication, le jugement d'adjudication constitue le
              titre de propriété.
            </P>
          </Section>

          <Section id="frais" title="Quels frais prévoir lors d'une vente immobilière judiciaire ?">
            <P>
              Le budget d'une vente judiciaire ne doit jamais être limité au prix d'adjudication. Il
              faut généralement prévoir :
            </P>
            <Checklist
              items={[
                "les frais préalables de vente ;",
                "les droits de mutation ;",
                "les émoluments ;",
                "les frais de publication ;",
                "les honoraires de l'avocat ;",
                "les frais de financement ;",
                "les charges de copropriété éventuellement dues ;",
                "les travaux ;",
                "les frais liés à l'occupation ou à la libération du bien ;",
                "une marge de sécurité.",
              ]}
            />
            <P>
              Immojudis met l'accent sur cette logique de coût complet. Un bien adjugé sous le prix
              du marché peut rester une mauvaise opération si les frais, travaux ou délais de
              libération sont sous-estimés.
            </P>
          </Section>

          <Section
            id="avantages"
            title="Quels sont les avantages des ventes immobilières judiciaires ?"
          >
            <P>
              Les ventes immobilières judiciaires peuvent donner accès à des biens peu visibles sur
              le marché classique. Certaines ventes présentent une mise à prix attractive, des biens
              à rénover, des emplacements recherchés ou des opportunités adaptées à une stratégie
              d'investissement.
            </P>
            <P>
              La procédure est publique et encadrée. Tous les enchérisseurs participent selon les
              mêmes règles. Le prix final se forme en audience, par confrontation directe entre les
              offres.
            </P>
            <P>
              Pour un investisseur préparé, ce marché peut donc offrir des opportunités. Mais la
              préparation doit être méthodique.
            </P>
          </Section>

          <Section id="risques" title="Quels sont les risques ?">
            <P>
              Les risques sont réels. Le premier risque est de se focaliser sur la mise à prix. Une
              mise à prix basse ne garantit pas une bonne affaire.
            </P>
            <P>
              Le deuxième risque est de mal lire le dossier. Une servitude, une occupation, une
              procédure en cours, une copropriété fragile ou un diagnostic défavorable peuvent
              modifier fortement la valeur du bien.
            </P>
            <P>
              Le troisième risque est financier. Si le financement n'est pas sécurisé,
              l'adjudicataire peut se retrouver dans l'incapacité de payer le prix.
            </P>
            <P>
              Le quatrième risque concerne les travaux. Une visite rapide ne permet pas toujours
              d'identifier précisément le coût de remise en état.
            </P>
            <P>
              Le cinquième risque est émotionnel. En audience, la concurrence peut pousser à
              dépasser son prix plafond. C'est précisément ce qu'il faut éviter.
            </P>
            <Callout>
              Immojudis a été pensé pour limiter ces risques en donnant une lecture structurée du
              dossier avant l'enchère.
            </Callout>
          </Section>

          <Section id="methode" title="La méthode Immojudis pour analyser une vente judiciaire">
            <P>Pour chaque opportunité, l'analyse doit suivre une méthode rigoureuse.</P>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {METHOD.map((step) => (
                <div key={step.n} className="liquid-panel-soft rounded-lg p-5">
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gold text-xs font-bold text-background">
                      {step.n}
                    </span>
                    <h3 className="text-base font-semibold text-foreground">{step.title}</h3>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.text}</p>
                </div>
              ))}
            </div>
            <P className="mt-6">
              C'est le cœur de l'approche Immojudis : analyser, décider, enchérir — dans cet ordre.
            </P>
          </Section>

          <Section id="lexique" title="Lexique des ventes immobilières judiciaires">
            <dl className="mt-2 divide-y divide-white/10 border-y border-white/10">
              {LEXIQUE.map((entry) => (
                <div key={entry.term} className="grid gap-1 py-4 sm:grid-cols-[14rem_1fr] sm:gap-6">
                  <dt className="font-semibold text-foreground">{entry.term}</dt>
                  <dd className="text-sm leading-relaxed text-muted-foreground">{entry.def}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section id="liens-institutionnels" title="Liens institutionnels utiles">
            <P>
              Pour compléter votre compréhension des ventes immobilières judiciaires, voici les
              principaux sites institutionnels à consulter.
            </P>
            <ul className="mt-4 grid gap-2.5">
              {INSTITUTIONAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Ext href={link.href}>{link.label}</Ext>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="faq" title="Questions fréquentes sur les ventes immobilières judiciaires">
            <div className="mt-2 divide-y divide-white/10 border-y border-white/10">
              {FAQ.map((item) => (
                <details key={item.q} className="group py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold text-foreground">
                    {item.q}
                    <span className="text-gold transition-transform group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
                </details>
              ))}
            </div>
          </Section>
        </div>

        {/* ── CTA ──────────────────────────────────────────────────────── */}
        <section className="liquid-panel relative mt-12 overflow-hidden rounded-lg p-7 sm:p-9">
          <span className="absolute -top-px left-9 h-px w-16 bg-gold" />
          <h2 className="font-display text-2xl text-foreground sm:text-3xl">
            Consultez les ventes judiciaires avec Immojudis
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Immojudis vous aide à repérer les ventes immobilières judiciaires, lire les informations
            utiles, identifier les risques et construire votre prix plafond avant l'audience. Avant
            d'enchérir, ne vous arrêtez pas à la mise à prix : analysez le dossier, vérifiez
            l'occupation, estimez les frais, comparez le marché, sécurisez votre financement, fixez
            votre limite.
          </p>
          <Link
            to="/sales"
            className="liquid-button mt-6 inline-flex items-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background transition hover:brightness-105"
          >
            Accéder aux ventes référencées <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </article>
    </main>
  );
}

function IntroCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="liquid-panel-soft rounded-lg p-5">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</p>
    </section>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 py-8">
      <header className="mb-4 flex items-baseline gap-4">
        <span className="liquid-hairline h-px w-8 shrink-0 translate-y-[-0.4rem]" />
        <h2 className="font-display text-2xl text-foreground sm:text-3xl">{title}</h2>
      </header>
      <div className="max-w-3xl">{children}</div>
    </section>
  );
}

function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`mt-4 text-[15px] leading-relaxed text-muted-foreground ${className ?? ""}`}>
      {children}
    </p>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-8 text-lg font-semibold text-gold-soft">{children}</h3>;
}

function Checklist({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 grid gap-2.5">
      {items.map((item) => (
        <li
          key={item}
          className="flex items-start gap-2.5 text-[15px] leading-relaxed text-muted-foreground"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-lg border-l-4 border-gold bg-gold/[0.07] px-5 py-4 text-[15px] leading-relaxed text-foreground">
      {children}
    </div>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-gold-soft underline underline-offset-4 transition-colors hover:text-gold"
    >
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}
