import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { prisma } from "../client";

async function getAllUsers({ usersId, select }: { usersId?: string[], select?: string[] }) {
	try {
		const query = {
			select: select ? { ...select.reduce((acc, field) => ({ ...acc, [field]: true }), {}) } : undefined,
			where: usersId ? { clerkId: { in: usersId } } : undefined,
		};

		const data = await prisma.user.findMany(query);
		return data;
	} catch (error) {
		console.log(error)
		return null
	}
}

export const postRouter = createTRPCRouter({
	releaseResult: publicProcedure
		.input(z.any())
		.mutation(async (opts: any) => {
			// Get data from Supabase
			const awards = await prisma.award.findMany();

			// Inputs
			const week = opts.input.week;
			const splitId = opts.input.splitId;

			// Get data from Supabase
			const participations = await prisma.participation.findMany({
				where: {
					League: {
						week: week,
						splitId: splitId,
					},
				},
				include: {
					League: true,
					UserTeam: {
						include: {
							Player: true,
						},
					},
					Player: true,
				},
			});

			const players = await prisma.player.findMany({
				where: {
					round: null,
					splitId: splitId,
					week: week,
				},
				orderBy: {
					id: 'desc',
				}
			})

			// Map participations
			const updatedParticipations = participations?.map((participation: any) => {
				let score = 0;
				const captain = participation.Player.name.toLowerCase();

				// Get the name of the user team players and find the updated score of the players
				const userTeam = participation.UserTeam.map((player: any) => {
					const name = player.Player.name.toLowerCase();
					const updatedPlayer = players?.find((player: any) => player.name.toLowerCase() === name); // Get the updated player

					if (updatedPlayer === undefined) {
						throw { message: JSON.stringify({ error: 'player_not_found', message: `O jogador ${name} não foi encontrado no banco de dados.` }) };
					}

					return updatedPlayer;

				});

				// Calculate the participant score
				userTeam.map((player: any) => {
					let playerScore = player.score
					score += (playerScore * (captain === player.name.toLowerCase() ? 1.5 : 1)) / 5;
				});

				return { ...participation, point: Number(score.toFixed(2)) };
			}).sort((a: any, b: any) => b.point - a.point);

			// Get all the unique leagueId
			let leagueIds: any = new Set()
			if (updatedParticipations) {
				for (let participation of updatedParticipations) {
					leagueIds.add(participation.leagueId);
				}
			}

			leagueIds = Array.from(leagueIds)

			// Insert data
			if (leagueIds) {
				var transactions: any = [];

				await Promise.all(leagueIds.map(async (leagueId: any) => {
					const participationsInALeague = updatedParticipations?.filter((participation: any) => participation.leagueId === leagueId)
					var lastPosition = 1;
					var lastScore;
					const participants: any = [];

					for (let index = 0; index < participationsInALeague!.length; index++) {
						const participation = participationsInALeague![index];
						var position = index + 1;
						const score = participation.point;

						if (lastScore == score) {
							position = lastPosition
						}

						lastPosition = position;
						lastScore = score;

						participants.push({ id: participation.id, position: position, score: score, clerkId: participation.userId, award: null, payment: participation.payment })
					}

					const awardsInLeague = awards?.filter((award: any) => award.leagueId === leagueId) || []

					// Add requests to transaction list
					const notificationsData: any = [];

					const usersBalance = await getAllUsers({
						usersId: participants.map((participation: any) => participation.clerkId),
						select: ['clerkId', 'money', 'bonus'],
					});

					console.log('participations: ', participants.length)

					participants.map((participation: any) => {
						const position = participation.position;
						const paymentMethod = participation.payment;
						const drawsQuantity = participants.filter((award: any) => award.position == position).length;
						const award = Math.floor((awardsInLeague.filter((award: any) => award.position >= position && award.position < position + drawsQuantity).reduce((sum: any, award: any) => sum += award.award, 0) / drawsQuantity) * 100) / 100;

						// Add balances transactions (money and bonus)
						if (award) {
							const previousMoney = usersBalance?.find((user: any) => user.clerkId == participation.clerkId)?.money;
							const previousBonus = usersBalance?.find((user: any) => user.clerkId == participation.clerkId)?.bonus;

							// Update balance and movimentations
							if (paymentMethod == 'money') {
								const newMoney = previousMoney! + award;
								transactions.push(
									prisma.$transaction([
										prisma.user.update({
											where: { clerkId: participation.clerkId },
											data: { money: newMoney, },
										}),
										prisma.moneyTransaction.create({
											data: {
												value: award,
												type: 'league_award',
												clerkId: participation.clerkId,
											}
										}),
										prisma.participation.update({
											where: { id: participation.id },
											data: {
												money: award,
												point: participation.score,
												position: participation.position,
											},
										})
									])
								);
							} else if (paymentMethod == 'bonus') {
								const newBonus = previousBonus! + award;
								transactions.push(
									prisma.$transaction([
										prisma.user.update({
											where: { clerkId: participation.clerkId },
											data: { bonus: newBonus, },
										}),
										prisma.bonusTransaction.create({
											data: {
												value: award,
												type: 'league_award',
												clerkId: participation.clerkId,
											}
										}),
										prisma.participation.update({
											where: { id: participation.id },
											data: {
												bonus: award,
												point: participation.score,
												position: participation.position,
											},
										})
									])
								);
							} else if (paymentMethod == 'mixed') {
								const newMoney = previousMoney! + Number((award / 2).toFixed(2));
								const newBonus = previousBonus! + Number((award / 2).toFixed(2));

								transactions.push(
									prisma.$transaction([
										prisma.user.update({
											where: { clerkId: participation.clerkId },
											data: { money: newMoney, },
										}),
										prisma.user.update({
											where: { clerkId: participation.clerkId },
											data: { bonus: newBonus, },
										}),
										prisma.moneyTransaction.create({
											data: {
												value: Number((award / 2).toFixed(2)),
												type: 'league_award',
												clerkId: participation.clerkId,
											}
										}),
										prisma.bonusTransaction.create({
											data: {
												value: Number((award / 2).toFixed(2)),
												type: 'league_award',
												clerkId: participation.clerkId,
											}
										}),
										prisma.participation.update({
											where: { id: participation.id },
											data: {
												money: Number((award / 2).toFixed(2)),
												bonus: Number((award / 2).toFixed(2)),
												point: participation.score,
												position: participation.position,
											},
										}),

									])
								);
							}
						} else {
							transactions.push(
								prisma.participation.update({
									where: { id: participation.id },
									data: {
										point: participation.score,
										position: participation.position,
										money: 0,
										bonus: 0,
									},
								})
							)
						}

						// Add notifications
						notificationsData.push({ userId: participation.clerkId, message: 'Teste not', read: false });
					});

					// Create notifications
					transactions.push(prisma.notification.createMany({
						data: notificationsData,
					}));
				}));

				console.log('transactions: ', transactions.length);

				const batchTransaction = async (transactions: any[]) => {
					var qnt = 0;
					const chunkSize = 100;

					for (let i = 0; i < transactions.length; i += chunkSize) {
						qnt++
						const chunk = transactions.slice(i, i + chunkSize);

						console.time(`chunk-${qnt}`)

						// Run queries in chunk
						const promises = chunk.map(async (transaction: any) => {
							const result = await transaction;
							return result;
						})

						await Promise.all(promises);

						console.timeEnd(`chunk-${qnt}`)
					}
				};

				console.time('Total time');

				await batchTransaction(transactions);

				console.timeEnd('Total time');
			}

			return 'ok';
		}),
});
