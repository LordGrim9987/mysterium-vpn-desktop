/**
 * Copyright (c) 2020 BlockDev AG
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { action, computed, observable, reaction } from "mobx"
import {
    ConnectionStatus,
    pricePerGiB,
    pricePerHour,
    ProposalQuality,
    qualityLevel,
    QualityLevel,
} from "mysterium-vpn-js"
import * as _ from "lodash"

import { RootStore } from "../store"
import { DaemonStatusType } from "../daemon/store"
import { userEvent } from "../analytics/analytics"
import { log } from "../log/log"
import { decimalPart } from "../payment/display"
import { ProposalFilters } from "../config/store"
import { tequilapi } from "../tequilapi"
import { ProposalViewAction } from "../analytics/actions"

import { compareProposal, newUIProposal, ProposalKey, proposalKey, UIProposal } from "./ui-proposal-type"

const supportedServiceType = "wireguard"

const proposalRefreshRate = 10000

export type TransientFilter = {
    text?: string
    country?: string
}

export class ProposalStore {
    @observable
    loading = false
    @observable
    proposals: UIProposal[] = []
    @observable
    quality: Map<ProposalKey, ProposalQuality> = new Map<ProposalKey, ProposalQuality>()

    @observable
    active?: UIProposal

    @observable
    filter: TransientFilter = {}

    root: RootStore

    constructor(root: RootStore) {
        this.root = root
    }

    setupReactions(): void {
        reaction(
            () => this.root.daemon.status,
            async (status) => {
                if (status == DaemonStatusType.Up && this.root.connection.status === ConnectionStatus.NOT_CONNECTED) {
                    await this.fetchProposals()
                }
            },
        )
        setInterval(async () => {
            if (this.root.daemon.status != DaemonStatusType.Up) {
                return
            }
            if (this.root.connection.status === ConnectionStatus.CONNECTED) {
                return
            }
            await this.fetchProposals()
            await this.fetchQuality()
        }, proposalRefreshRate)
    }

    @computed
    get filters(): ProposalFilters {
        return this.root.filters.config
    }

    @action
    async fetchProposals(): Promise<void> {
        if (this.loading) {
            return
        }
        this.setLoading(true)
        try {
            const proposals = await tequilapi
                .findProposals({ serviceType: supportedServiceType })
                .then((proposals) => proposals.map(newUIProposal))
            this.setProposals(proposals)
        } catch (err) {
            log.error("Could not get proposals", err.message)
        }
        this.setLoading(false)
    }

    @action
    async fetchQuality(): Promise<void> {
        if (this.loading) {
            return
        }
        this.setLoading(true)
        try {
            const quality = await tequilapi.proposalsQuality()
            if (quality.length) {
                this.setQuality(quality)
            }
        } catch (err) {
            log.error("Could not get proposal quality", err.message)
        }
        this.setLoading(false)
    }

    @computed
    get proposalsWithQuality(): UIProposal[] {
        return this.proposals.map((proposal) => {
            const proposalQuality = this.quality.get(proposal.key)
            return {
                ...proposal,
                quality: proposalQuality,
                ...{ qualityLevel: qualityLevel(proposalQuality) },
            }
        })
    }

    // #####################
    // Access policy filter (invisible yet)
    // #####################

    @computed
    get accessPolicyFiltered(): UIProposal[] {
        const input = this.proposalsWithQuality
        if (!this.filters.other?.["no-access-policy"]) {
            return input
        }
        return input.filter((p) => !p.accessPolicies).sort(compareProposal)
    }

    // #####################
    // Text filter
    // #####################

    @action
    setTextFilter(text?: string): void {
        this.filter.text = text
        this.setCountryFilter(undefined)
        userEvent(ProposalViewAction.FilterText, text)
    }

    @computed
    get textFiltered(): UIProposal[] {
        const input = this.accessPolicyFiltered
        const filterText = this.filter.text
        if (!filterText) {
            return input
        }
        return input.filter((p) => p.providerId.includes(filterText)).sort(compareProposal)
    }

    // #####################
    // Price filter
    // #####################

    @action
    setPricePerHourMaxFilter(pricePerHourMax: number): void {
        this.root.filters.setPartial({
            price: {
                perhour: pricePerHourMax,
            },
        })
        userEvent(ProposalViewAction.FilterPriceTime, String(pricePerHourMax))
    }

    @action
    setPricePerHourMaxFilterDebounced = _.debounce(this.setPricePerHourMaxFilter, 800)

    @action
    setPricePerGibMaxFilter(pricePerGibMax: number): void {
        this.root.filters.setPartial({
            price: {
                pergib: pricePerGibMax,
            },
        })
        userEvent(ProposalViewAction.FilterPriceData, String(pricePerGibMax))
    }

    @action
    setPricePerGibMaxFilterDebounced = _.debounce(this.setPricePerGibMaxFilter, 800)

    @computed
    get toleratedPrices(): { perHourMax?: number; perGibMax?: number } {
        const tolerance = 0.000005 * decimalPart()
        let perHourMax
        const filterPricePerHourMax = this.filters.price?.perhour
        if (filterPricePerHourMax !== undefined) {
            perHourMax = filterPricePerHourMax + (filterPricePerHourMax !== 0 ? tolerance : 0)
        }
        let perGibMax
        const filterPricePerGibMax = this.filters.price?.pergib
        if (filterPricePerGibMax !== undefined) {
            perGibMax = filterPricePerGibMax + (filterPricePerGibMax !== 0 ? tolerance : 0)
        }
        return { perHourMax: perHourMax, perGibMax }
    }

    @computed
    get priceFiltered(): UIProposal[] {
        const input = this.textFiltered
        const filterPricePerHourMax = this.filters.price?.perhour
        const filterPricePerGibMax = this.filters.price?.pergib
        if (filterPricePerHourMax == null && filterPricePerGibMax == null) {
            return input
        }
        return input.filter((p) => {
            const proposalPricePerHour = pricePerHour(p.paymentMethod).amount / 60
            const pricePerGib = pricePerGiB(p.paymentMethod).amount
            const tolerated = this.toleratedPrices
            return (
                (tolerated.perHourMax === undefined || proposalPricePerHour <= tolerated.perHourMax) &&
                (tolerated.perGibMax === undefined || pricePerGib <= tolerated.perGibMax)
            )
        })
    }

    // #####################
    // Quality filter
    // #####################

    @action
    setQualityFilter(level: QualityLevel): void {
        this.root.filters.setPartial({
            quality: { level },
        })
        userEvent(ProposalViewAction.FilterQuality, level ? QualityLevel[level] : undefined)
    }

    @action
    setIncludeFailed(includeFailed: boolean): void {
        this.root.filters.setPartial({
            quality: {
                "include-failed": includeFailed,
            },
        })
        userEvent(ProposalViewAction.FilterIncludeFailed, String(includeFailed))
    }

    @computed
    get qualityFiltered(): UIProposal[] {
        const input = this.priceFiltered
        const filterQuality = this.filters.quality?.level
        const filterIncludeFailed = this.filters.quality?.["include-failed"]
        if (!filterQuality && !filterIncludeFailed) {
            return input
        }
        return input.filter((p) => {
            if (filterQuality != null && p.qualityLevel != null && p.qualityLevel < filterQuality) {
                return false
            }
            if (!filterIncludeFailed && p.quality?.monitoringFailed) {
                return false
            }
            return true
        })
    }

    // #####################
    // IP type filter
    // #####################

    @computed
    get ipTypeCounts(): { [type: string]: number } {
        const input = this.qualityFiltered
        const result = _.groupBy(input, (p) => p.nodeType)
        return _.mapValues(result, (ps) => ps.length)
    }

    @action
    setIpTypeFilter(ipType?: string): void {
        this.root.filters.setPartial({
            other: {
                "ip-type": ipType,
            },
        })
        this.setCountryFilter(undefined)
    }

    @action
    toggleIpTypeFilter(ipType?: string): void {
        this.setIpTypeFilter(this.filters.other?.["ip-type"] !== ipType ? ipType : "")
        userEvent(ProposalViewAction.FilterIpType, ipType)
    }

    @computed
    get ipTypeFiltered(): UIProposal[] {
        const input = this.qualityFiltered
        if (!this.root.config.config.desktop.filters?.other?.["ip-type"]) {
            return input
        }
        return input.filter((p) => p.nodeType === this.filters.other?.["ip-type"])
    }

    // #####################
    // Country filter
    // #####################

    @computed
    get countryCounts(): { [code: string]: number } {
        const input = this.ipTypeFiltered
        const result = _.groupBy(input, (p) => p.country)
        return _.mapValues(result, (ps) => ps.length)
    }

    @action
    setCountryFilter(countryCode?: string): void {
        this.filter.country = countryCode
    }

    @action
    toggleCountryFilter(countryCode?: string): void {
        this.setCountryFilter(this.filter.country !== countryCode ? countryCode : undefined)
        this.toggleActiveProposal(undefined)
        userEvent(ProposalViewAction.FilterCountry, countryCode)
    }

    @computed
    get countryFiltered(): UIProposal[] {
        const input = this.ipTypeFiltered
        if (!this.filter.country) {
            return input
        }
        return input.filter((p) => p.country == this.filter.country)
    }

    // #####################
    // Resulting list of proposals
    // #####################

    @computed
    get filteredProposals(): UIProposal[] {
        return this.countryFiltered.sort(compareProposal)
    }

    // #####################
    // End of filters
    // #####################

    @action
    toggleActiveProposal(proposal?: UIProposal): void {
        this.active = this.active?.key !== proposal?.key ? proposal : undefined
        userEvent(ProposalViewAction.SelectProposal, proposal?.country)
    }

    @action
    setLoading = (b: boolean): void => {
        this.loading = b
    }

    @action
    setProposals = (proposals: UIProposal[]): void => {
        this.proposals = proposals
    }

    @action
    setQuality = (quality: ProposalQuality[]): void => {
        for (const q of quality) {
            this.quality.set(proposalKey(q), q)
        }
    }
}
